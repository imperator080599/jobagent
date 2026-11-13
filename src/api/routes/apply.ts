// Moteur de candidature : plan, lancement, questions à compléter, indicateurs,
// matrice des plateformes, et points d'entrée de l'extension de navigateur.
import { z } from 'zod';
import { enqueue } from '../../core/queue.js';
import { getSetting } from '../../core/settings.js';
import { applicationForUrl, answerQuestions, automationMetrics, listAttempts, planAutomation } from '../../apply/automation.js';
import { PLATFORM_POLICIES, detectPlatform, policyFor } from '../../apply/platforms.js';
import { fillStats, resolveFields } from '../../apply/resolve.js';
import { recordSubmission } from '../../apply/service.js';
import { and, eq } from 'drizzle-orm';
import { applications, cvVersions, letters } from '../../db/schema.js';
import { getJob } from '../../tracker/stage.js';
import { type AppDeps, body, router } from '../http.js';
import { requireScope, sessionOnly } from '../middleware.js';

const Field = z.object({
  key: z.string().max(80),
  tag: z.enum(['input', 'select', 'textarea', 'combobox']),
  type: z.string().max(40),
  label: z.string().max(600),
  name: z.string().max(300),
  id: z.string().max(300),
  required: z.boolean(),
  options: z.array(z.object({ value: z.string().max(400), label: z.string().max(600) })).max(400),
  multiple: z.boolean(),
  accept: z.string().max(300),
  value: z.string().max(20_000),
  checked: z.boolean().optional(),
  placeholder: z.string().max(300),
  autocomplete: z.string().max(80),
  section: z.string().max(300),
  maxLength: z.number().int().optional(),
});

export function applyRoutes(deps: AppDeps) {
  const r = router();
  const { ctx } = deps;

  /** Matrice des plateformes : ce qui est permis, ce qui ne l'est pas, et la preuve. */
  r.get('/platforms', async (c) => c.json({ platforms: Object.values(PLATFORM_POLICIES) }));

  r.get('/metrics', async (c) => c.json(await automationMetrics(c.get('uctx'))));

  r.get('/:jobId/plan', async (c) => c.json(await planAutomation(c.get('uctx'), c.req.param('jobId'))));

  r.get('/:jobId/attempts', async (c) => c.json({ attempts: await listAttempts(c.get('uctx'), c.req.param('jobId')) }));

  /** Lance (ou relance) la candidature : jamais de second envoi pour une candidature déjà partie. */
  r.post('/:jobId/run', sessionOnly, async (c) => {
    const uctx = c.get('uctx');
    const input = await body(c, z.object({ afterVerification: z.boolean().optional() }));
    const job = await getJob(uctx, c.req.param('jobId'));
    const task = await enqueue(ctx.db, { type: 'application.run', userId: uctx.userId, payload: { jobId: job.id, trigger: 'user', afterVerification: input.afterVerification ?? false }, idempotencyKey: `application.run:${job.id}`, priority: 92, runAfter: ctx.now() });
    deps.kick(c);
    return c.json({ queued: Boolean(task) });
  });

  /** Réponses aux questions d'une candidature : enregistrées une fois, réutilisées pour toutes les suivantes. */
  r.post('/:jobId/answers', sessionOnly, async (c) => {
    const input = await body(c, z.object({ answers: z.array(z.object({ label: z.string().max(600), question: z.string().max(600).optional(), answer: z.string().max(10_000), scope: z.enum(['general', 'country', 'company', 'job']).optional(), sensitive: z.boolean().optional() })).max(60) }));
    const res = await answerQuestions(c.get('uctx'), c.req.param('jobId'), input.answers);
    deps.kick(c);
    return c.json(res);
  });

  // ── Extension (jeton à portée « apply ») : remplissage dans le navigateur de l'utilisateur ──

  /** Candidature correspondant à la page ouverte, et politique de la plateforme. */
  r.post('/extension/lookup', requireScope('apply'), async (c) => {
    const input = await body(c, z.object({ url: z.string().url().max(4000) }));
    const platform = detectPlatform(input.url);
    const policy = policyFor(platform);
    const match = await applicationForUrl(c.get('uctx'), input.url);
    return c.json({ platform, policy: { name: policy.name, autonomy: policy.autonomy, limits: policy.limits }, match });
  });

  /** Réponses pour les champs lus par l'extension (mêmes règles que le moteur : rien n'est inventé). */
  r.post('/extension/resolve', requireScope('apply'), async (c) => {
    const uctx = c.get('uctx');
    const input = await body(c, z.object({ url: z.string().url().max(4000), jobId: z.string().max(60), fields: z.array(Field).max(400) }));
    const platform = detectPlatform(input.url);
    if (policyFor(platform).autonomy === 'manual') return c.json({ platform, refused: true, reason: `${policyFor(platform).name} n'autorise pas le remplissage automatique : utilisez les réponses préparées dans JobAgent.` });
    const job = await getJob(uctx, input.jobId);
    const [app] = await ctx.db.select().from(applications).where(and(eq(applications.userId, uctx.userId), eq(applications.jobId, job.id)));
    const [cv] = app?.cvVersionId ? await ctx.db.select().from(cvVersions).where(and(eq(cvVersions.id, app.cvVersionId), eq(cvVersions.userId, uctx.userId))) : [];
    const [letter] = app?.letterId ? await ctx.db.select().from(letters).where(and(eq(letters.id, app.letterId), eq(letters.userId, uctx.userId))) : [];
    const docs = {
      resume: cv?.pdfFileId ? { fileId: cv.pdfFileId, filename: `CV.pdf` } : null,
      coverLetter: letter?.pdfFileId ? { fileId: letter.pdfFileId, filename: `Lettre.pdf` } : null,
      letterText: letter?.text ?? '',
    };
    const autopilot = await getSetting(ctx.db, uctx.userId, 'application.autopilot');
    const fields = await resolveFields(uctx, input.fields, { job, cv: cv ?? null, docs, autopilot, sourceLabel: '' });
    return c.json({ platform, fields, stats: fillStats(fields) });
  });

  /** Confirmation lue par l'extension après votre envoi : la candidature est enregistrée avec sa preuve. */
  r.post('/extension/confirm', requireScope('apply'), async (c) => {
    const input = await body(c, z.object({ jobId: z.string().max(60), url: z.string().max(4000), text: z.string().min(10).max(4000) }));
    const pack = await recordSubmission(c.get('uctx'), input.jobId, { channel: policyFor(detectPlatform(input.url)).name, confirmationText: input.text, confirmationUrl: input.url, notes: 'Envoyée par vous, formulaire rempli par l’extension JobAgent' });
    return c.json({ ok: true, stage: pack.job.stage });
  });

  return r;
}
