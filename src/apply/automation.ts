// Moteur de candidature : décide du mode (envoi automatique, remplissage avec envoi par
// l'utilisateur, ou préparation manuelle), exécute le pilote de navigateur, et range le
// résultat : candidature envoyée avec sa preuve, questions à poser une seule fois,
// intervention humaine précise (CAPTCHA, connexion, déclaration…), ou envoi incertain.
//
// Garanties tenues par le code :
//  - une candidature n'est « envoyée » qu'avec une confirmation réelle lue sur la page
//    (ou fournie par l'utilisateur) ; sinon elle est « incertaine » et rien n'est renvoyé ;
//  - l'envoi est inscrit en base avant le clic : une reprise après panne ne renvoie jamais ;
//  - seuls les documents validés de CETTE candidature sont joints ;
//  - la politique de la plateforme fixe le plafond ; vos règles AUTOPILOT peuvent l'abaisser.
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Browser } from 'playwright-core';
import type { UserContext } from '../core/context.js';
import { logActivity } from '../core/activity.js';
import { badRequest, conflict, notFound } from '../core/errors.js';
import { getFile, saveFile } from '../core/files.js';
import { raiseAction, resolveAction, resolveActionsFor } from '../core/inbox.js';
import { enqueue } from '../core/queue.js';
import { getSetting } from '../core/settings.js';
import { normalize } from '../core/text.js';
import { newId } from '../db/ids.js';
import { applicationAttempts, applications, cvVersions, jobSightings, jobs, letters, sources } from '../db/schema.js';
import { upsertAnswer } from '../profile/answers.js';
import { isSubmitted } from '../shared/stages.js';
import type { SettingValue } from '../shared/settings.js';
import { getJob, setStage, type Job } from '../tracker/stage.js';
import { applicationUrl } from './engine/adapters.js';
import type { RunFile, RunOutcome, RunResult } from './engine/runner.js';
import { type Autonomy, detectPlatform, effectiveAutonomy, type PlatformId, policyFor } from './platforms.js';
import type { FormField } from './questions.js';
import { type ApplicationDocs, fillStats, type ResolvedField, resolveFields } from './resolve.js';

export type Attempt = typeof applicationAttempts.$inferSelect;
type Autopilot = SettingValue<'application.autopilot'>;

export interface AutomationPlan {
  jobId: string;
  applicationId: string | null;
  url: string;
  platform: PlatformId;
  mode: Autonomy;
  /** Conditions examinées, avec leur résultat : l'utilisateur voit pourquoi ce mode a été retenu. */
  checks: { id: string; ok: boolean; label: string }[];
  autopilot: boolean;
}

const SOURCE_LABELS: Record<string, string> = {
  linkedin: 'LinkedIn',
  linkedin_alert: 'LinkedIn',
  indeed: 'Indeed',
  wttj: 'Welcome to the Jungle',
  apec: 'Apec',
  hellowork: 'HelloWork',
  efinancialcareers: 'eFinancialCareers',
  glassdoor: 'Glassdoor',
  jobteaser: 'JobTeaser',
  francetravail: 'France Travail',
  vie: 'Mon Volontariat International',
};

/** Source réelle de l'offre, telle qu'enregistrée lors de sa découverte. */
async function sourceLabel(ctx: UserContext, job: Job): Promise<string> {
  const [first] = await ctx.db
    .select({ type: sources.type, name: sources.name })
    .from(jobSightings)
    .leftJoin(sources, eq(sources.id, jobSightings.sourceId))
    .where(eq(jobSightings.jobId, job.id))
    .orderBy(jobSightings.firstSeenAt)
    .limit(1);
  const type = first?.type ?? '';
  if (SOURCE_LABELS[type]) return SOURCE_LABELS[type]!;
  for (const [k, v] of Object.entries(SOURCE_LABELS)) if (normalize(first?.name ?? '').includes(k)) return v;
  return ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workday', 'workable', 'recruitee', 'personio', 'teamtailor', 'manual', 'company', 'careers'].includes(type) ? "Site carrières de l'entreprise" : '';
}

async function automaticSubmissionsSince(ctx: UserContext, since: Date): Promise<number> {
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(applicationAttempts)
    .where(and(eq(applicationAttempts.userId, ctx.userId), eq(applicationAttempts.status, 'submitted'), eq(applicationAttempts.mode, 'auto'), gte(applicationAttempts.startedAt, since)));
  return row?.n ?? 0;
}

/** Les règles AUTOPILOT de l'utilisateur sont-elles toutes remplies pour cette offre ? */
async function autopilotChecks(ctx: UserContext, job: Job, ap: Autopilot, hasLetter: boolean): Promise<AutomationPlan['checks']> {
  const checks: AutomationPlan['checks'] = [];
  const add = (id: string, ok: boolean, label: string) => checks.push({ id, ok, label });
  add('enabled', ap.enabled, ap.enabled ? 'AUTOPILOT activé' : 'AUTOPILOT désactivé (mode VALIDATION)');
  const title = normalize(`${job.title} ${job.descriptionText.slice(0, 4000)}`);
  if (ap.countries.length) add('country', ap.countries.map((c) => c.toUpperCase()).includes((job.country || '').toUpperCase()), `Pays autorisés : ${ap.countries.join(', ')} (offre : ${job.country || 'inconnu'})`);
  if (ap.contracts.length) add('contract', ap.contracts.map(normalize).includes(normalize(job.contractType || '')), `Contrats autorisés : ${ap.contracts.join(', ')} (offre : ${job.contractType || 'inconnu'})`);
  if (ap.titleKeywords.length) add('keywords', ap.titleKeywords.some((k) => normalize(job.title).includes(normalize(k))), `Intitulés visés : ${ap.titleKeywords.join(', ')}`);
  if (ap.excludeKeywords.length) add('exclude', !ap.excludeKeywords.some((k) => title.includes(normalize(k))), `Mots exclus : ${ap.excludeKeywords.join(', ')}`);
  add('ats', job.atsScore != null && job.atsScore >= ap.minAtsScore, `Note ATS attribuée ≥ ${ap.minAtsScore}/20 (offre : ${job.atsScore ?? '—'})`);
  add('priority', (job.priorityScore ?? 0) >= ap.minPriority, `Priorité ≥ ${ap.minPriority} (offre : ${job.priorityScore ?? '—'})`);
  if (ap.requireLetter) add('letter', hasLetter, 'Lettre de motivation validée exigée');
  const flags = (job.flags ?? {}) as { injection?: unknown[] };
  add('injection', !flags.injection?.length, "Annonce sans texte adressé à une IA");
  const now = ctx.now();
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const week = new Date(now.getTime() - 7 * 86400_000);
  const today = await automaticSubmissionsSince(ctx, day);
  const lastWeek = await automaticSubmissionsSince(ctx, week);
  add('day_cap', today < ap.maxPerDay, `Plafond quotidien : ${today}/${ap.maxPerDay} envois automatiques`);
  add('week_cap', lastWeek < ap.maxPerWeek, `Plafond sur 7 jours : ${lastWeek}/${ap.maxPerWeek}`);
  return checks;
}

export async function planAutomation(ctx: UserContext, jobId: string): Promise<AutomationPlan> {
  const job = await getJob(ctx, jobId);
  const [app] = await ctx.db.select().from(applications).where(and(eq(applications.userId, ctx.userId), eq(applications.jobId, jobId)));
  const raw = app?.applyUrl || job.applyUrl || job.canonicalUrl;
  const platform = raw ? detectPlatform(raw) : 'generic';
  const url = raw ? applicationUrl(platform, raw) : '';
  const ap = await getSetting(ctx.db, ctx.userId, 'application.autopilot');
  const dryRun = await getSetting(ctx.db, ctx.userId, 'application.dryRun');
  const checks = await autopilotChecks(ctx, job, ap, Boolean(app?.letterId));
  const rulesOk = checks.every((c) => c.ok);
  const policy = policyFor(platform);
  // Envoi automatique : règles AUTOPILOT remplies, ou autorisation donnée pour cette candidature précise.
  const authorizedHere = app?.mode === 'auto' && app.authorizedBy === 'user';
  const wanted: Autonomy = (rulesOk && ap.platforms[platform] === 'auto') || (authorizedHere && ap.platforms[platform] !== 'manual' && ap.platforms[platform] !== 'prefill') ? 'auto' : ap.platforms[platform] === 'manual' ? 'manual' : 'prefill';
  let mode = effectiveAutonomy(platform, { [platform]: wanted });
  checks.push({ id: 'platform', ok: policy.autonomy !== 'manual', label: `${policy.name} : ${policy.autonomy === 'auto' ? 'envoi automatique permis' : policy.autonomy === 'prefill' ? 'remplissage automatique, envoi par vous' : 'aucune automatisation permise'}` });
  if (!url) {
    checks.push({ id: 'url', ok: false, label: "Aucune adresse de candidature connue" });
    mode = 'manual';
  }
  if (!app?.cvVersionId) {
    checks.push({ id: 'documents', ok: false, label: 'Documents de la candidature non validés' });
    mode = 'manual';
  }
  if (dryRun && mode === 'auto') {
    checks.push({ id: 'dry_run', ok: false, label: 'Mode TEST actif : rien n’est réellement envoyé' });
    mode = 'prefill';
  }
  return { jobId, applicationId: app?.id ?? null, url, platform, mode, checks, autopilot: rulesOk };
}

async function applicationDocs(ctx: UserContext, app: typeof applications.$inferSelect, jobId: string): Promise<{ docs: ApplicationDocs; files: Map<string, RunFile>; cv: typeof cvVersions.$inferSelect | null }> {
  const files = new Map<string, RunFile>();
  let cv: typeof cvVersions.$inferSelect | null = null;
  let resume: ApplicationDocs['resume'] = null;
  let coverLetter: ApplicationDocs['coverLetter'] = null;
  let resumeDocx: ApplicationDocs['resume'] = null;
  let coverLetterDocx: ApplicationDocs['resume'] = null;
  const load = async (id: string | null | undefined) => {
    const f = id ? await getFile(ctx.db, ctx.userId, id) : null;
    if (!f) return null;
    files.set(f.id, { name: f.filename, mime: f.mime, data: f.data });
    return { fileId: f.id, filename: f.filename };
  };
  let letterText = '';
  if (app.cvVersionId) {
    [cv] = await ctx.db.select().from(cvVersions).where(and(eq(cvVersions.id, app.cvVersionId), eq(cvVersions.userId, ctx.userId)));
    // Le document joint doit appartenir à cette candidature : jamais le CV d'une autre offre.
    if (cv && cv.jobId && cv.jobId !== jobId) throw conflict('Le CV rattaché à cette candidature appartient à une autre offre.');
    resume = await load(cv?.pdfFileId);
    resumeDocx = await load(cv?.docxFileId);
  }
  if (app.letterId) {
    const [letter] = await ctx.db.select().from(letters).where(and(eq(letters.id, app.letterId), eq(letters.userId, ctx.userId)));
    if (letter && letter.jobId && letter.jobId !== jobId) throw conflict('La lettre rattachée à cette candidature appartient à une autre offre.');
    letterText = letter?.text ?? '';
    coverLetter = await load(letter?.pdfFileId);
    coverLetterDocx = await load(letter?.docxFileId);
  }
  return { docs: { resume, coverLetter, resumeDocx, coverLetterDocx, letterText }, files, cv };
}

export interface AutomationResult {
  plan: AutomationPlan;
  attempt: Attempt | null;
  outcome: RunOutcome | { status: 'manual' } | { status: 'already_submitted' };
}

const HUMAN_TEXT: Record<string, string> = {
  captcha: 'Un contrôle anti-robots (CAPTCHA) doit être résolu par vous. Tout le reste est rempli : ouvrez le formulaire avec l’extension JobAgent, qui le remplit à l’identique, puis résolvez le contrôle et envoyez.',
  login: 'La plateforme demande votre compte candidat. Connectez-vous vous-même (JobAgent ne demande ni ne conserve vos mots de passe) : l’extension remplira ensuite le formulaire.',
  otp: 'Un code de vérification vous a été envoyé par la plateforme : saisissez-le, l’extension reprend ensuite le remplissage.',
  legal: 'Une déclaration ou une acceptation juridique doit être cochée par vous (ou autorisée une fois dans vos règles AUTOPILOT).',
  validation: 'La page a refusé une ou plusieurs réponses : vérifiez-les avant de poursuivre.',
  unknown_form: 'Le formulaire n’a pas pu être reconnu automatiquement : ouvrez-le avec l’extension, qui remplit ce qu’elle reconnaît.',
  platform: 'Cette plateforme n’autorise pas la candidature automatique : tout est préparé pour que vous la fassiez vous-même en quelques minutes.',
  technical: 'Incident technique : la candidature est reprise automatiquement, sans risque de double envoi.',
};

/** Exécute (ou prépare) la candidature d'une offre. Sûr à rappeler : jamais de second envoi. */
export async function runAutomation(ctx: UserContext, jobId: string, opts: { browser?: Browser; trigger?: string; prepareContext?: (c: import('playwright-core').BrowserContext) => Promise<void>; /** Nouvelle tentative confirmée par l'utilisateur après vérification d'un envoi incertain. */ afterVerification?: boolean } = {}): Promise<AutomationResult> {
  const plan = await planAutomation(ctx, jobId);
  const job = await getJob(ctx, jobId);
  const [app] = await ctx.db.select().from(applications).where(and(eq(applications.userId, ctx.userId), eq(applications.jobId, jobId)));
  if (!app) throw notFound("Aucune candidature préparée pour cette offre : validez d'abord ses documents.");
  if (app.submittedAt || isSubmitted(job.stage)) return { plan, attempt: null, outcome: { status: 'already_submitted' } };
  // Une tentative interrompue pendant l'envoi n'est jamais rejouée : elle devient « incertaine ».
  const [pending] = await ctx.db.select().from(applicationAttempts).where(and(eq(applicationAttempts.applicationId, app.id), eq(applicationAttempts.status, 'submitting')));
  if (pending) {
    await ctx.db.update(applicationAttempts).set({ status: 'uncertain', error: "Interruption pendant l'envoi : vérification nécessaire avant toute nouvelle tentative.", finishedAt: ctx.now() }).where(eq(applicationAttempts.id, pending.id));
    await raiseUncertain(ctx, job, app.id, "Une tentative a été interrompue pendant l'envoi. JobAgent ne renvoie rien sans votre vérification.");
    return { plan, attempt: { ...pending, status: 'uncertain' }, outcome: { status: 'uncertain', detail: 'interruption pendant l’envoi' } };
  }
  // Envoi incertain lors d'une tentative précédente : rien n'est retenté tant que vous n'avez pas vérifié.
  const uncertain = await ctx.db.select().from(applicationAttempts).where(and(eq(applicationAttempts.applicationId, app.id), eq(applicationAttempts.status, 'uncertain')));
  if (uncertain.length) {
    if (!opts.afterVerification) return { plan, attempt: uncertain[0]!, outcome: { status: 'uncertain', detail: "Envoi incertain lors d'une tentative précédente : vérification requise avant toute nouvelle tentative." } };
    await ctx.db.update(applicationAttempts).set({ status: 'not_sent', error: 'Vérifié par vous : candidature non partie.' }).where(and(eq(applicationAttempts.applicationId, app.id), eq(applicationAttempts.status, 'uncertain')));
    await resolveAction(ctx.db, ctx.userId, { dedupKey: `application.verify:${jobId}` }, { verified: 'not_sent' });
  }
  const [attempt] = await ctx.db
    .insert(applicationAttempts)
    .values({ id: newId('att'), userId: ctx.userId, applicationId: app.id, driver: plan.mode === 'manual' ? 'manual' : 'browser', dryRun: plan.mode !== 'auto', status: 'running', platform: plan.platform, mode: plan.mode, url: plan.url, trigger: opts.trigger ?? 'user' })
    .returning();
  const finishAttempt = async (patch: Partial<Attempt>) => {
    const [row] = await ctx.db.update(applicationAttempts).set({ ...patch, finishedAt: ctx.now() }).where(eq(applicationAttempts.id, attempt!.id)).returning();
    return row!;
  };

  if (plan.mode === 'manual') {
    const done = await finishAttempt({ status: 'manual', reason: 'platform' });
    await raiseManual(ctx, job, plan);
    return { plan, attempt: done, outcome: { status: 'manual' } };
  }

  const ap = await getSetting(ctx.db, ctx.userId, 'application.autopilot');
  const { docs, files, cv } = await applicationDocs(ctx, app, jobId);
  const label = await sourceLabel(ctx, job);
  const shots: string[] = [];
  const stepsLog: unknown[] = [];
  const { runApplication } = await import('./engine/runner.js');
  if (job.stage === 'ready_to_apply') await setStage(ctx, jobId, 'applying', { actor: 'agent:apply', reason: plan.mode === 'auto' ? 'candidature automatique en cours' : 'formulaire en cours de préparation', soft: true });
  const result: RunResult = await runApplication({
    url: plan.url,
    mode: plan.mode,
    browser: opts.browser,
    prepareContext: opts.prepareContext,
    files,
    allowPlatform: (p) => policyFor(p).autonomy !== 'manual',
    resolve: (fields: FormField[]) => resolveFields(ctx, fields, { job, cv, docs, autopilot: ap, sourceLabel: label }),
    beforeSubmit: async () => {
      // Inscription de l'envoi avant le clic : verrou contre tout second envoi, même après une panne.
      const [fresh] = await ctx.db.select({ submittedAt: applications.submittedAt }).from(applications).where(eq(applications.id, app.id));
      if (fresh?.submittedAt) return false;
      const locked = await ctx.db
        .update(applicationAttempts)
        .set({ status: 'submitting' })
        .where(and(eq(applicationAttempts.id, attempt!.id), eq(applicationAttempts.status, 'running'), sql`not exists (select 1 from application_attempts a where a.application_id = ${app.id} and a.status in ('submitting', 'submitted') and a.id <> ${attempt!.id})`))
        .returning();
      return locked.length === 1;
    },
    onStep: async (s) => {
      let shot: string | undefined;
      if (s.screenshot?.byteLength) {
        shot = await saveFile(ctx.db, { userId: ctx.userId, kind: 'screenshot', filename: `candidature-${jobId}-${s.kind}.png`, mime: 'image/png', data: s.screenshot, refType: 'attempt', refId: attempt!.id });
        shots.push(shot);
      }
      stepsLog.push({ at: s.at, kind: s.kind, detail: s.detail, page: s.page, screenshotFileId: shot });
      await ctx.db.update(applicationAttempts).set({ steps: stepsLog, screenshotFileIds: shots }).where(eq(applicationAttempts.id, attempt!.id));
    },
  });

  const fields = result.pages.flatMap((p) => p.fields);
  const stats = { ...fillStats(fields), pages: result.pages.length, durationMs: result.durationMs, finalUrl: result.finalUrl };
  const o = result.outcome;
  const base = { fields: fields as unknown[], stats: stats as unknown as Record<string, unknown>, platform: result.platform, error: 'detail' in o ? o.detail : '', reason: o.status === 'needs_human' ? o.reason : '' };
  let done: Attempt;
  switch (o.status) {
    case 'submitted': {
      done = await finishAttempt({ ...base, status: 'submitted' });
      await recordAutomaticSubmission(ctx, job, app.id, plan, o.confirmation, shots[shots.length - 1] ?? null);
      break;
    }
    case 'ready_to_submit':
      done = await finishAttempt({ ...base, status: 'ready_to_submit' });
      await raiseHandoff(ctx, job, plan, 'ready', fields);
      break;
    case 'needs_answers':
      done = await finishAttempt({ ...base, status: 'needs_answers' });
      await raiseQuestions(ctx, job, app.id, fields);
      break;
    case 'needs_human':
      done = await finishAttempt({ ...base, status: 'needs_human' });
      await raiseHandoff(ctx, job, plan, o.reason, fields, o.detail);
      break;
    case 'uncertain':
      done = await finishAttempt({ ...base, status: 'uncertain' });
      await raiseUncertain(ctx, job, app.id, o.detail);
      break;
    default:
      done = await finishAttempt({ ...base, status: 'failed' });
      break;
  }
  if (o.status !== 'submitted' && o.status !== 'uncertain') {
    const current = await getJob(ctx, jobId);
    if (current.stage === 'applying') await setStage(ctx, jobId, 'ready_to_apply', { actor: 'agent:apply', reason: o.status === 'needs_answers' ? 'questions à compléter' : o.status === 'ready_to_submit' ? 'formulaire prêt : envoi par vous' : 'intervention nécessaire', soft: true });
  }
  await logActivity(ctx.db, {
    userId: ctx.userId,
    actor: 'agent:apply',
    action: `application.${o.status}`,
    level: o.status === 'failed' ? 'error' : o.status === 'uncertain' || o.status === 'needs_human' ? 'warn' : 'info',
    summary: `${job.companyName} — ${job.title} : ${o.status === 'submitted' ? 'candidature envoyée et confirmée par la page' : o.status === 'ready_to_submit' ? 'formulaire rempli, envoi par vous' : o.status === 'needs_answers' ? 'questions à compléter' : o.status === 'needs_human' ? `intervention : ${o.reason}` : o.status === 'uncertain' ? 'envoi incertain' : 'échec technique'} (${stats.ready}/${stats.total} champs remplis, ${policyFor(result.platform).name})`,
    entityType: 'job',
    entityId: jobId,
    data: { attemptId: attempt!.id, platform: result.platform, mode: plan.mode, stats },
  });
  if (o.status === 'failed') throw new Error(`Candidature automatique : ${o.detail}`);
  return { plan, attempt: done, outcome: o };
}

async function recordAutomaticSubmission(ctx: UserContext, job: Job, applicationId: string, plan: AutomationPlan, confirmation: { text: string; url: string }, screenshotFileId: string | null) {
  const now = ctx.now();
  const rules = await getSetting(ctx.db, ctx.userId, 'followup.rules');
  await ctx.db
    .update(applications)
    .set({
      mode: 'auto',
      channel: policyFor(plan.platform).name,
      submittedAt: now,
      confirmation: { text: confirmation.text, url: confirmation.url, source: 'page', screenshotFileId, at: now.toISOString() },
      confirmedAt: now,
      lastActivityAt: now,
      followUpDueAt: new Date(now.getTime() + rules.firstAfterDays * 86400_000),
      updatedAt: now,
    })
    .where(eq(applications.id, applicationId));
  await setStage(ctx, job.id, 'sent', { actor: 'agent:apply', reason: `envoyée automatiquement via ${policyFor(plan.platform).name}`, soft: true });
  await setStage(ctx, job.id, 'confirmed', { actor: 'agent:apply', reason: 'confirmation affichée par la plateforme', soft: true });
  await resolveActionsFor(ctx.db, ctx.userId, { jobId: job.id, types: ['application.submit', 'application.validate', 'application.questions', 'application.handoff', 'application.verify', 'application.manual'] }, { submitted: true });
}

async function raiseQuestions(ctx: UserContext, job: Job, applicationId: string, fields: ResolvedField[]) {
  const questions = fields
    .filter((f) => f.required && f.status === 'missing')
    .map((f) => ({ key: f.key, label: f.label, question: f.ask?.question ?? f.label, scope: f.ask?.scope ?? 'general', options: f.ask?.options ?? [], reason: f.reason ?? '', suggestion: f.suggestion ?? '', sensitive: Boolean(f.sensitive), canonical: f.canonical }));
  await raiseAction(ctx.db, {
    userId: ctx.userId,
    type: 'application.questions',
    title: `${questions.length} question(s) pour postuler : ${job.companyName} — ${job.title}`,
    jobId: job.id,
    applicationId,
    priority: 86,
    dedupKey: `application.questions:${job.id}`,
    reopen: true,
    body: { questions, filled: fields.filter((f) => f.status === 'ready').length, total: fields.length },
  });
}

async function raiseHandoff(ctx: UserContext, job: Job, plan: AutomationPlan, reason: string, fields: ResolvedField[], detail = '') {
  const filled = fields.filter((f) => f.status === 'ready').length;
  await raiseAction(ctx.db, {
    userId: ctx.userId,
    type: 'application.handoff',
    title: reason === 'ready' ? `Envoyer la candidature : ${job.companyName} — ${job.title}` : `Intervention requise : ${job.companyName} — ${job.title}`,
    jobId: job.id,
    applicationId: plan.applicationId,
    priority: reason === 'ready' ? 84 : 88,
    dedupKey: `application.handoff:${job.id}`,
    reopen: true,
    body: {
      reason,
      text: reason === 'ready' ? `Le formulaire ${policyFor(plan.platform).name} est entièrement préparé (${filled} champ(s)). L’envoi vous revient sur cette plateforme : ouvrez-le avec l’extension JobAgent, qui le remplit à l’identique, vérifiez puis envoyez.` : (HUMAN_TEXT[reason] ?? detail),
      detail,
      url: plan.url,
      platform: plan.platform,
      filled,
      total: fields.length,
      human: fields.filter((f) => f.status === 'needs_human').map((f) => ({ label: f.label, reason: f.reason })),
    },
  });
}

async function raiseUncertain(ctx: UserContext, job: Job, applicationId: string, detail: string) {
  await raiseAction(ctx.db, {
    userId: ctx.userId,
    type: 'application.verify',
    title: `Vérifier l’envoi : ${job.companyName} — ${job.title}`,
    jobId: job.id,
    applicationId,
    priority: 90,
    dedupKey: `application.verify:${job.id}`,
    reopen: true,
    body: { text: `${detail} Un accusé de réception reçu par e-mail sera rapproché automatiquement. Aucun nouvel envoi n’est fait sans votre accord.`, detail },
  });
}

async function raiseManual(ctx: UserContext, job: Job, plan: AutomationPlan) {
  const policy = policyFor(plan.platform);
  await raiseAction(ctx.db, {
    userId: ctx.userId,
    type: 'application.manual',
    title: `Postuler vous-même : ${job.companyName} — ${job.title}`,
    jobId: job.id,
    applicationId: plan.applicationId,
    priority: 80,
    dedupKey: `application.manual:${job.id}`,
    reopen: true,
    body: { text: plan.url ? HUMAN_TEXT.platform : "Aucune adresse de candidature : retrouvez la page de l'offre ou indiquez l'adresse.", url: plan.url, platform: plan.platform, limits: policy.limits, evidence: policy.evidence.slice(0, 1), checks: plan.checks },
  });
}

/** Réponses de l'utilisateur aux questions d'une candidature : enregistrées une fois, réutilisées partout, puis reprise automatique. */
export async function answerQuestions(ctx: UserContext, jobId: string, answers: { label: string; question?: string; answer: string; scope?: 'general' | 'country' | 'company' | 'job'; sensitive?: boolean }[]): Promise<{ saved: number; relaunched: boolean }> {
  const job = await getJob(ctx, jobId);
  let saved = 0;
  for (const a of answers) {
    if (!a.answer.trim()) continue;
    const scope = a.scope ?? 'general';
    const scopeValue = scope === 'company' ? job.companyName : scope === 'country' ? job.country : scope === 'job' ? job.id : '';
    if (scope === 'country' && !scopeValue) throw badRequest("Le pays de l'offre est inconnu : choisissez une autre portée.");
    const row = await upsertAnswer(ctx.db, ctx.userId, { question: a.question?.trim() || a.label, answer: a.answer.trim(), scope, scopeValue, sensitive: a.sensitive ?? false, status: 'validated', source: 'user' });
    // La formulation exacte du formulaire est mémorisée : la même question ne sera plus jamais posée.
    if (a.label && normalize(a.label) !== row.questionNorm && !row.variants.includes(a.label)) {
      const { recordAnswerUse } = await import('../profile/answers.js');
      await recordAnswerUse(ctx.db, row, a.label);
    }
    saved++;
  }
  await resolveAction(ctx.db, ctx.userId, { dedupKey: `application.questions:${jobId}` }, { answered: saved });
  const relaunched = Boolean(await enqueue(ctx.db, { type: 'application.run', userId: ctx.userId, payload: { jobId, trigger: 'answers' }, idempotencyKey: `application.run:${jobId}`, priority: 88, runAfter: ctx.now() }));
  return { saved, relaunched };
}

/** Indicateurs du moteur de candidature (sur les tentatives réelles enregistrées). */
export async function automationMetrics(ctx: UserContext, sinceDays = 90) {
  const since = new Date(ctx.now().getTime() - sinceDays * 86400_000);
  const rows = await ctx.db.select().from(applicationAttempts).where(and(eq(applicationAttempts.userId, ctx.userId), gte(applicationAttempts.startedAt, since))).orderBy(desc(applicationAttempts.startedAt));
  const browserRuns = rows.filter((r) => r.driver === 'browser' && r.status !== 'running');
  const rates = browserRuns.map((r) => (r.stats as { autoRate?: number } | null)?.autoRate).filter((x): x is number => typeof x === 'number');
  const durations = browserRuns.map((r) => (r.stats as { durationMs?: number } | null)?.durationMs).filter((x): x is number => typeof x === 'number');
  const byApp = new Map<string, Attempt[]>();
  for (const r of rows) byApp.set(r.applicationId, [...(byApp.get(r.applicationId) ?? []), r]);
  let withoutIntervention = 0;
  let submittedApps = 0;
  for (const list of byApp.values()) {
    if (!list.some((r) => r.status === 'submitted')) continue;
    submittedApps++;
    if (!list.some((r) => ['needs_answers', 'needs_human', 'ready_to_submit', 'uncertain'].includes(r.status))) withoutIntervention++;
  }
  const reasons: Record<string, number> = {};
  for (const r of rows) if (['needs_human', 'needs_answers', 'uncertain', 'manual', 'ready_to_submit'].includes(r.status)) reasons[r.reason || r.status] = (reasons[r.reason || r.status] ?? 0) + 1;
  const [confirmed] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(applications).where(and(eq(applications.userId, ctx.userId), sql`${applications.confirmedAt} is not null`, gte(applications.updatedAt, since)));
  return {
    attempts: rows.length,
    applications: byApp.size,
    averageAutoFillRate: rates.length ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length) : null,
    submittedWithoutIntervention: withoutIntervention,
    submittedApplications: submittedApps,
    shareWithoutIntervention: submittedApps ? Math.round((withoutIntervention / submittedApps) * 100) : null,
    averageRunSeconds: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 1000) : null,
    blocked: rows.filter((r) => ['needs_human', 'needs_answers'].includes(r.status)).length,
    interventionReasons: reasons,
    confirmedSubmissions: confirmed?.n ?? 0,
    uncertain: rows.filter((r) => r.status === 'uncertain').length,
    failures: rows.filter((r) => r.status === 'failed').length,
    byPlatform: Object.fromEntries([...new Set(rows.map((r) => r.platform))].map((p) => [p, rows.filter((r) => r.platform === p).length])),
  };
}

/** Pour l'extension : candidature en cours correspondant à la page ouverte par l'utilisateur. */
export async function applicationForUrl(ctx: UserContext, url: string): Promise<{ jobId: string; applicationId: string } | null> {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return '';
    }
  })();
  if (!host) return null;
  const rows = await ctx.db
    .select({ jobId: applications.jobId, applicationId: applications.id, applyUrl: applications.applyUrl, jobApply: jobs.applyUrl, canonical: jobs.canonicalUrl, stage: jobs.stage })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .where(and(eq(applications.userId, ctx.userId), inArray(jobs.stage, ['ready_to_apply', 'applying'])));
  const path = (u: string) => {
    try {
      const x = new URL(u);
      return `${x.host}${x.pathname.replace(/\/(apply|application|c\/new)\/?$/, '').replace(/\/$/, '')}`;
    } catch {
      return '';
    }
  };
  const target = path(url);
  const hit = rows.find((r) => [r.applyUrl, r.jobApply, r.canonical].some((u) => u && (path(u) === target || target.startsWith(path(u)))));
  return hit ? { jobId: hit.jobId, applicationId: hit.applicationId } : null;
}

export async function listAttempts(ctx: UserContext, jobId: string): Promise<Attempt[]> {
  const [app] = await ctx.db.select({ id: applications.id }).from(applications).where(and(eq(applications.userId, ctx.userId), eq(applications.jobId, jobId)));
  if (!app) return [];
  return ctx.db.select().from(applicationAttempts).where(eq(applicationAttempts.applicationId, app.id)).orderBy(desc(applicationAttempts.startedAt));
}
