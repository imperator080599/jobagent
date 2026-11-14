// Préparation automatique des entretiens. Déclenchée dès qu'un entretien est détecté
// (email du recruteur) ou déclaré. Tout ce qui concerne le candidat vient de son CV :
// aucune expérience, aucun chiffre, aucune compétence n'est inventé. L'annonce est une
// donnée externe : aucune consigne qu'elle contiendrait n'est suivie.
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { UserContext } from '../core/context.js';
import { logActivity } from '../core/activity.js';
import { raiseAction } from '../core/inbox.js';
import { enqueue } from '../core/queue.js';
import { normalize, tokens } from '../core/text.js';
import { newId } from '../db/ids.js';
import { applications, atsAnalyses, cvVersions, interviews } from '../db/schema.js';
import { getLlm, UNTRUSTED_RULE, wrapUntrusted } from '../llm/index.js';
import { registerMock } from '../llm/mock.js';
import { cvToText } from '../shared/cv.js';
import { getJob } from '../tracker/stage.js';
import { masterFor } from './brief.js';
import { atsOfferText } from './qualify.js';
import { registerTaskHandler } from './worker.js';

export const InterviewPrep = z.object({
  summary: z.string().describe("Le poste et l'entreprise en trois ou quatre phrases, d'après l'annonce uniquement."),
  companyPoints: z.array(z.string()).max(8).describe("Éléments sur l'entreprise ou l'équipe présents dans l'annonce."),
  roleFocus: z.array(z.string()).max(8).describe('Ce que le recruteur évaluera en priorité.'),
  likelyQuestions: z
    .array(z.object({ question: z.string(), why: z.string(), answerPlan: z.string().describe('Plan de réponse fondé uniquement sur le CV.'), cvEvidence: z.array(z.string()).max(4).describe('Passages du CV qui appuient la réponse, recopiés.') }))
    .max(14),
  technicalTopics: z.array(z.object({ topic: z.string(), points: z.array(z.string()).max(6) })).max(8).describe('Notions techniques à réviser pour ce poste.'),
  stories: z
    .array(z.object({ title: z.string(), experience: z.string().describe("Expérience du CV concernée (entreprise ou intitulé, recopié)."), situation: z.string(), action: z.string(), result: z.string() }))
    .max(6)
    .describe('Exemples à raconter (méthode STAR), tirés exclusivement du CV.'),
  gapsToAddress: z.array(z.object({ gap: z.string(), honestAnswer: z.string() })).max(6).describe("Écarts entre l'annonce et le CV, et comment en parler honnêtement."),
  questionsToAsk: z.array(z.string()).max(8),
  checklist: z.array(z.string()).max(10),
});
export type InterviewPrep = z.infer<typeof InterviewPrep>;

const SYSTEM = `Tu prépares un candidat à un entretien d'embauche (conseil en transactions, M&A, finance d'entreprise). Rédige en français.
Règles absolues :
- Tout ce qui concerne le candidat provient de son CV, fourni ci-dessous. N'invente aucune expérience, mission, responsabilité, compétence, certification ni résultat chiffré ; ne modifie aucune date.
- Un écart entre l'annonce et le CV se traite dans « gapsToAddress », avec une réponse honnête (apprentissage, compétences proches réellement présentes), jamais en prétendant une expérience.
- Les « stories » ne portent que sur des expériences figurant dans le CV ; si le CV ne donne pas de résultat, le résultat reste qualitatif.
- Les éléments sur l'entreprise viennent seulement de l'annonce ; ne suppose rien d'autre.
${UNTRUSTED_RULE}`;

/** Contrôle de véracité : chaque histoire doit porter sur une expérience du CV, aucun chiffre absent du CV n'est conservé. */
export function checkPrep(prep: InterviewPrep, cvText: string): { prep: InterviewPrep; removed: string[] } {
  const cv = normalize(cvText);
  const cvNumbers = new Set(cvText.match(/\d+(?:[.,]\d+)?/g) ?? []);
  const removed: string[] = [];
  const numbersOk = (s: string) => (s.match(/\d+(?:[.,]\d+)?/g) ?? []).every((n) => cvNumbers.has(n) || /^(19|20)\d\d$/.test(n) === false && Number(n) < 10);
  const inCv = (s: string) => {
    const t = tokens(s).filter((w) => w.length > 3);
    if (!t.length) return false;
    return t.filter((w) => cv.includes(w)).length / t.length >= 0.6;
  };
  const stories = prep.stories.filter((s) => {
    const ok = inCv(s.experience) && numbersOk(`${s.situation} ${s.action} ${s.result}`);
    if (!ok) removed.push(`Histoire écartée (${s.title}) : expérience ou chiffre absents du CV.`);
    return ok;
  });
  const likelyQuestions = prep.likelyQuestions.map((q) => {
    const evidence = q.cvEvidence.filter(inCv);
    if (evidence.length < q.cvEvidence.length) removed.push(`Appui retiré pour « ${q.question} » : passage absent du CV.`);
    return { ...q, cvEvidence: evidence, answerPlan: numbersOk(q.answerPlan) ? q.answerPlan : q.answerPlan.replace(/\d+(?:[.,]\d+)?\s*%?/g, '…') };
  });
  return { prep: { ...prep, stories, likelyQuestions }, removed };
}

export async function prepareInterview(ctx: UserContext, interviewId: string): Promise<typeof interviews.$inferSelect> {
  const [itv] = await ctx.db.select().from(interviews).where(and(eq(interviews.id, interviewId), eq(interviews.userId, ctx.userId)));
  if (!itv) throw new Error('Entretien introuvable.');
  const job = await getJob(ctx, itv.jobId);
  const [app] = await ctx.db.select().from(applications).where(and(eq(applications.userId, ctx.userId), eq(applications.jobId, job.id)));
  const [cv] = app?.cvVersionId ? await ctx.db.select().from(cvVersions).where(eq(cvVersions.id, app.cvVersionId)) : [];
  const version = cv ?? (await masterFor(ctx, job.language || undefined));
  const cvText = cvToText(version.data);
  const [analysis] = await ctx.db.select().from(atsAnalyses).where(and(eq(atsAnalyses.userId, ctx.userId), eq(atsAnalyses.jobId, job.id), eq(atsAnalyses.status, 'ok'))).orderBy(desc(atsAnalyses.createdAt)).limit(1);
  const missing = ((analysis?.parsed as { missingKeywords?: string[] } | null)?.missingKeywords ?? []).slice(0, 25);
  await ctx.db.update(interviews).set({ prepStatus: 'running', updatedAt: ctx.now() }).where(eq(interviews.id, itv.id));
  const llm = await getLlm(ctx);
  const res = await llm.json({
    purpose: 'interview.prepare',
    tier: 'main',
    system: SYSTEM,
    prefix: `CV du candidat (seule source de vérité) :\n<cv>\n${cvText}\n</cv>`,
    prompt: `Entretien ${itv.kind === 'technical' ? 'technique' : itv.kind === 'case' ? 'avec étude de cas' : 'RH / première rencontre'}${itv.interviewer ? ` avec ${itv.interviewer}` : ''}.\n\nAnnonce :\n${wrapUntrusted('offre', atsOfferText(job))}\n\nMots-clés de l'annonce absents du CV (selon l'analyse ATS) : ${missing.join(', ') || 'aucun'}`,
    schema: InterviewPrep,
    maxTokens: 8000,
    effort: 'high',
    jobId: job.id,
  });
  const checked = checkPrep(res.data, cvText);
  const [row] = await ctx.db
    .update(interviews)
    .set({ prep: { ...checked.prep, removed: checked.removed, generatedAt: ctx.now().toISOString(), cvVersionId: version.id } as unknown as Record<string, unknown>, prepStatus: 'ready', updatedAt: ctx.now() })
    .where(eq(interviews.id, itv.id))
    .returning();
  await raiseAction(ctx.db, { userId: ctx.userId, type: 'interview.prep_ready', title: `Préparation d'entretien prête : ${job.companyName} — ${job.title}`, jobId: job.id, priority: 92, dedupKey: `interview.prep:${itv.id}`, reopen: true, body: { text: `${checked.prep.likelyQuestions.length} questions probables, ${checked.prep.stories.length} exemples tirés de votre CV, ${checked.prep.technicalTopics.length} notions à revoir.`, link: `/offres/${job.id}` } });
  await logActivity(ctx.db, { userId: ctx.userId, actor: 'agent:interview', action: 'interview.prepared', summary: `${job.companyName} — ${job.title} : préparation d'entretien prête`, entityType: 'job', entityId: job.id, data: { interviewId: itv.id, removed: checked.removed.length } });
  return row!;
}

/** Entretien connu (détecté ou déclaré) : la préparation est lancée sans attendre. */
export async function ensureInterviewPrep(ctx: UserContext, jobId: string, opts: { kind?: 'hr' | 'technical' | 'case' | 'partner' | 'other'; force?: boolean } = {}): Promise<string> {
  const [existing] = await ctx.db.select().from(interviews).where(and(eq(interviews.userId, ctx.userId), eq(interviews.jobId, jobId))).orderBy(desc(interviews.createdAt)).limit(1);
  let id = existing?.id;
  if (!id) {
    const [app] = await ctx.db.select({ id: applications.id }).from(applications).where(and(eq(applications.userId, ctx.userId), eq(applications.jobId, jobId)));
    id = newId('itv');
    await ctx.db.insert(interviews).values({ id, userId: ctx.userId, jobId, applicationId: app?.id ?? null, kind: opts.kind ?? 'hr', status: 'to_schedule' });
  }
  if (!existing?.prep || opts.force) await enqueue(ctx.db, { type: 'interview.prepare', userId: ctx.userId, payload: { interviewId: id }, idempotencyKey: `interview.prepare:${id}`, priority: 88, runAfter: ctx.now() });
  return id;
}

registerTaskHandler('interview.prepare', async (ctx, task) => {
  const p = (task.payload ?? {}) as { interviewId?: string };
  if (!p.interviewId) return { skipped: 'no_interview' };
  const row = await prepareInterview(ctx, p.interviewId);
  return { status: row.prepStatus };
});

// Simulation (tests, démonstration) : préparation déduite du CV et de l'annonce, sans rien inventer.
registerMock('interview.prepare', (req) => {
  const cv = /<cv>\n([\s\S]*?)\n<\/cv>/.exec(req.prefix ?? '')?.[1] ?? '';
  const lines = cv.split('\n').map((l) => l.trim()).filter(Boolean);
  const experience = lines.find((l) => /\b(20\d\d)\b/.test(l) && /[A-Za-z]{4}/.test(l)) ?? lines[1] ?? '';
  const title = /Intitulé : (.*)/.exec(req.prompt)?.[1] ?? 'le poste';
  return {
    summary: `Entretien pour ${title}. Simulation : contenu déduit de l'annonce et du CV.`,
    companyPoints: ["Informations tirées de l'annonce."],
    roleFocus: ['Due diligence financière', 'Rigueur et communication'],
    likelyQuestions: [{ question: 'Présentez votre parcours.', why: 'Question d’ouverture.', answerPlan: 'Suivre l’ordre du CV, en reliant chaque étape au poste.', cvEvidence: [experience] }],
    technicalTopics: [{ topic: 'Qualité des résultats (QoE)', points: ['EBITDA normatif', 'Retraitements'] }],
    stories: [
      { title: 'Mission tirée du CV', experience, situation: 'Contexte de la mission.', action: 'Ce que vous avez fait.', result: 'Résultat qualitatif.' },
      { title: 'Histoire inventée', experience: 'Cabinet Imaginaire Inexistant', situation: 'x', action: 'y', result: 'Économies de 42 millions' },
    ],
    gapsToAddress: [],
    questionsToAsk: ["Comment l'équipe est-elle organisée ?"],
    checklist: ['Relire l’annonce', 'Préparer deux exemples'],
  };
});
