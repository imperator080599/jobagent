// Messagerie : connexion Gmail (OAuth), emails rattachés aux candidatures, brouillons, relances.
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { logActivity } from '../../core/activity.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors.js';
import { resolveAction } from '../../core/inbox.js';
import { enqueue, unblockByReason } from '../../core/queue.js';
import { listSecretHints } from '../../core/secrets.js';
import { getSetting, setSetting } from '../../core/settings.js';
import { applications, drafts, emails, interviews, jobs } from '../../db/schema.js';
import { getLastRun } from '../../pipeline/scheduler.js';
import { dueFollowUps } from '../../tracker/followup.js';
import { disconnect, finishAuth, readState, redirectUri, startAuth } from '../../tracker/gmail.js';
import { MAIL_LABELS, applyMailEffects, pushDraft, type MailCategory } from '../../tracker/mail.js';
import { type AppDeps, body, isHttps, router } from '../http.js';
import { sessionOnly } from '../middleware.js';

const OAUTH_COOKIE = 'ja_oauth';

export function mailRoutes(deps: AppDeps) {
  const r = router();
  const { ctx } = deps;

  r.get('/status', async (c) => {
    const uctx = c.get('uctx');
    const cfg = await getSetting(ctx.db, uctx.userId, 'email.gmail');
    const hints = await listSecretHints(ctx.db, uctx.userId);
    return c.json({
      gmail: { ...cfg, clientSecretConfigured: Boolean(hints.google_client_secret), connected: cfg.canRead && Boolean(hints.gmail_refresh_token), redirectUri: redirectUri(uctx) },
      schedule: await getSetting(ctx.db, uctx.userId, 'schedule.email'),
      lastSyncAt: await getLastRun(ctx, uctx.userId, 'mail.cursor'),
    });
  });

  /** Réglages modifiables par l'utilisateur. Les autorisations accordées ne se déclarent pas : elles viennent de Google. */
  r.put('/gmail/settings', sessionOnly, async (c) => {
    const input = await body(c, z.object({ clientId: z.string().trim().max(200).optional(), allowSend: z.boolean().optional(), lookbackDays: z.number().int().min(1).max(180).optional(), importAlerts: z.boolean().optional() }));
    const uctx = c.get('uctx');
    const cfg = await getSetting(ctx.db, uctx.userId, 'email.gmail');
    if (input.allowSend && !cfg.canCompose) throw conflict("L'envoi suppose d'avoir d'abord accordé l'autorisation de rédaction.");
    const next = await setSetting(ctx.db, uctx.userId, 'email.gmail', { ...cfg, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) });
    return c.json({ gmail: next });
  });

  /** Prépare la redirection vers Google. `access=read` : lecture seule ; `access=compose` : lecture et rédaction de brouillons. */
  r.post('/gmail/start', sessionOnly, async (c) => {
    const input = await body(c, z.object({ access: z.enum(['read', 'compose']).default('read') }));
    const { url, verifier } = await startAuth(c.get('uctx'), input.access).catch((err) => {
      throw badRequest((err as Error).message);
    });
    setCookie(c, OAUTH_COOKIE, verifier, { httpOnly: true, secure: isHttps(c), sameSite: 'Lax', path: '/api/mail/gmail', maxAge: 900 });
    return c.json({ url });
  });

  r.get('/gmail/callback', async (c) => {
    const back = (status: string, message = '') => c.redirect(`/parametres/messagerie?gmail=${status}${message ? `&message=${encodeURIComponent(message)}` : ''}`);
    const verifier = getCookie(c, OAUTH_COOKIE);
    deleteCookie(c, OAUTH_COOKIE, { path: '/api/mail/gmail' });
    if (c.req.query('error')) return back('refuse', "Vous n'avez pas accordé l'autorisation.");
    const state = readState(ctx, c.req.query('state') ?? '');
    const code = c.req.query('code');
    // Le retour doit correspondre à la demande faite par ce même utilisateur, dans ce même navigateur.
    if (!state || !code || !verifier || state.userId !== c.get('user').id) throw forbidden('Retour de connexion invalide ou expiré. Relancez la connexion depuis les paramètres.');
    try {
      const res = await finishAuth(c.get('uctx'), code, verifier);
      await logActivity(ctx.db, { userId: state.userId, actor: 'user', action: 'gmail.connected', summary: `Gmail connecté (${res.account}) : lecture${res.canCompose ? ' et rédaction de brouillons' : ' seule'}` });
      await resolveAction(ctx.db, state.userId, { dedupKey: 'setup.gmail' }, { connected: true });
      await unblockByReason(ctx.db, state.userId, ['gmail_not_connected', 'gmail_compose_missing']);
      await enqueue(ctx.db, { type: 'mail.sync', userId: state.userId, idempotencyKey: `mail.sync:${state.userId}`, runAfter: ctx.now(), priority: 60, maxAttempts: 2 });
      deps.kick(c);
      return back('ok');
    } catch (err) {
      return back('erreur', (err as Error).message);
    }
  });

  r.post('/gmail/disconnect', sessionOnly, async (c) => {
    await disconnect(c.get('uctx'));
    await logActivity(ctx.db, { userId: c.get('user').id, actor: 'user', action: 'gmail.disconnected', summary: 'Accès à Gmail révoqué' });
    return c.json({ ok: true });
  });

  r.post('/sync', sessionOnly, async (c) => {
    const userId = c.get('user').id;
    const cfg = await getSetting(ctx.db, userId, 'email.gmail');
    if (!cfg.canRead) throw conflict("Gmail n'est pas connecté.");
    await enqueue(ctx.db, { type: 'mail.sync', userId, idempotencyKey: `mail.sync:${userId}`, runAfter: ctx.now(), priority: 70, maxAttempts: 2 });
    deps.kick(c);
    return c.json({ ok: true });
  });

  /** Vue de suivi : emails liés aux candidatures, brouillons en attente, relances dues, entretiens. */
  r.get('/overview', async (c) => {
    const uctx = c.get('uctx');
    const [mails, pending, due, upcoming] = await Promise.all([
      ctx.db
        .select({ id: emails.id, fromName: emails.fromName, fromAddr: emails.fromAddr, subject: emails.subject, date: emails.date, snippet: emails.snippet, category: emails.category, confidence: emails.confidence, jobId: emails.jobId, needsReview: emails.needsReview, extracted: emails.extracted, jobTitle: jobs.title, companyName: jobs.companyName })
        .from(emails)
        .leftJoin(jobs, eq(jobs.id, emails.jobId))
        .where(and(eq(emails.userId, uctx.userId), inArray(emails.category, ['confirmation', 'interview', 'rejection', 'offer', 'recruiter_request', 'other'])))
        .orderBy(desc(emails.date))
        .limit(80),
      ctx.db.select({ draft: drafts, jobTitle: jobs.title, companyName: jobs.companyName }).from(drafts).leftJoin(jobs, eq(jobs.id, drafts.jobId)).where(and(eq(drafts.userId, uctx.userId), eq(drafts.status, 'draft'))).orderBy(desc(drafts.createdAt)).limit(40),
      dueFollowUps(uctx),
      ctx.db.select({ interview: interviews, jobTitle: jobs.title, companyName: jobs.companyName }).from(interviews).innerJoin(jobs, eq(jobs.id, interviews.jobId)).where(and(eq(interviews.userId, uctx.userId), inArray(interviews.status, ['to_schedule', 'scheduled']))).orderBy(interviews.scheduledAt).limit(40),
    ]);
    return c.json({ emails: mails.map((m) => ({ ...m, label: MAIL_LABELS[m.category as MailCategory] ?? m.category, summary: (m.extracted as { summary?: string } | null)?.summary ?? '', extracted: undefined })), drafts: pending.map((d) => ({ ...d.draft, jobTitle: d.jobTitle, companyName: d.companyName })), followUps: due, interviews: upcoming.map((i) => ({ ...i.interview, jobTitle: i.jobTitle, companyName: i.companyName })) });
  });

  /** Rattachement ou correction par l'utilisateur d'un email incertain. */
  r.post('/emails/:id/assign', sessionOnly, async (c) => {
    const uctx = c.get('uctx');
    const input = await body(c, z.object({ jobId: z.string().nullable(), category: z.enum(['confirmation', 'interview', 'rejection', 'offer', 'recruiter_request', 'other']) }));
    const [email] = await ctx.db.select().from(emails).where(and(eq(emails.id, c.req.param('id')), eq(emails.userId, uctx.userId)));
    if (!email) throw notFound();
    let applied = false;
    if (input.jobId && input.category !== 'other') {
      const [row] = await ctx.db.select({ jobId: jobs.id, applicationId: applications.id, companyName: jobs.companyName, companyNorm: jobs.companyNorm, title: jobs.title, stage: jobs.stage, submittedAt: applications.submittedAt }).from(jobs).leftJoin(applications, and(eq(applications.jobId, jobs.id), eq(applications.userId, uctx.userId))).where(and(eq(jobs.id, input.jobId), eq(jobs.userId, uctx.userId)));
      if (!row) throw notFound('Offre introuvable.');
      const extracted = (email.extracted ?? {}) as { summary?: string; proposedDate?: string };
      await applyMailEffects(uctx, email, row, input.category, { summary: extracted.summary ?? '', proposedDate: extracted.proposedDate ?? '' });
      applied = true;
    }
    await ctx.db.update(emails).set({ jobId: input.jobId, category: input.category, needsReview: false, matchMethod: 'utilisateur', confidence: 1 }).where(eq(emails.id, email.id));
    await resolveAction(ctx.db, uctx.userId, { dedupKey: `mail.review:${email.id}` }, { by: 'user' });
    return c.json({ ok: true, applied });
  });

  r.put('/drafts/:id', sessionOnly, async (c) => {
    const input = await body(c, z.object({ toAddr: z.string().trim().max(320).optional(), subject: z.string().max(300).optional(), body: z.string().max(20_000).optional() }));
    const [row] = await ctx.db.update(drafts).set({ ...input, updatedAt: ctx.now() }).where(and(eq(drafts.id, c.req.param('id')), eq(drafts.userId, c.get('user').id), eq(drafts.status, 'draft'))).returning();
    if (!row) throw notFound();
    return c.json({ draft: row });
  });
  /** Dépose le brouillon dans Gmail. L'envoi reste un geste de l'utilisateur, dans sa messagerie. */
  r.post('/drafts/:id/push', sessionOnly, async (c) => {
    try {
      return c.json(await pushDraft(c.get('uctx'), c.req.param('id')));
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  });
  r.post('/drafts/:id/discard', sessionOnly, async (c) => {
    await ctx.db.update(drafts).set({ status: 'discarded', updatedAt: ctx.now() }).where(and(eq(drafts.id, c.req.param('id')), eq(drafts.userId, c.get('user').id)));
    return c.json({ ok: true });
  });

  return r;
}
