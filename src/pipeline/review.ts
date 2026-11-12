// Suite donnée à une analyse ATS, et boucle de feedback.
//  - Au-dessus du seuil choisi par l'utilisateur, l'offre lui est présentée dans le
//    centre de validation, avec les questions restées sans réponse (jamais reposées).
//  - Ses réponses sont rangées selon leur portée : profil (valables pour toutes les
//    candidatures), candidature (cette offre seulement), style (règles de rédaction).
//  - Une offre faiblement notée n'est pas masquée : elle reste consultable, et elle
//    est tout de même présentée si elle est stratégique ou ajoutée à la main.
import { and, eq } from 'drizzle-orm';
import type { UserContext } from '../core/context.js';
import { logActivity } from '../core/activity.js';
import { badRequest, conflict } from '../core/errors.js';
import { raiseAction, resolveActionsFor, snoozeAction, getAction } from '../core/inbox.js';
import { enqueue } from '../core/queue.js';
import { getSetting } from '../core/settings.js';
import { normalize } from '../core/text.js';
import { newId } from '../db/ids.js';
import { actionItems, feedback, jobs } from '../db/schema.js';
import { getFact, listSkillFacts, setFact, setSkillFact } from '../profile/facts.js';
import { skillFactKey } from '../shared/facts.js';
import { ATS_DECISION_LABELS, isSubmitted, type AtsDecision } from '../shared/stages.js';
import { getJob, setStage, type Job } from '../tracker/stage.js';
import { recordAtsOnJob, type AtsRunResult } from './ats.js';

export interface ReviewQuestion {
  keyword: string;
  key: string;
}

/** Mots-clés manquants sur lesquels l'utilisateur ne s'est encore jamais prononcé. */
export async function openQuestions(ctx: UserContext, missingKeywords: string[], cvText: string, max = 8): Promise<ReviewQuestion[]> {
  const known = new Set((await listSkillFacts(ctx.db, ctx.userId)).map((s) => skillFactKey(s.name)));
  const cv = normalize(cvText);
  const out: ReviewQuestion[] = [];
  for (const k of missingKeywords) {
    const keyword = k.trim();
    const key = skillFactKey(keyword);
    if (!keyword || keyword.length > 60 || known.has(key) || out.some((q) => q.key === key)) continue;
    if (cv.includes(normalize(keyword))) continue;
    out.push({ keyword, key });
    if (out.length >= max) break;
  }
  return out;
}

export interface AfterAnalysis {
  route: 'review' | 'auto' | 'archive';
  questions: ReviewQuestion[];
}

/** Applique le résultat de l'analyse de référence (CV master) à l'offre et décide de la suite. */
export async function afterAnalysis(ctx: UserContext, job: Job, r: AtsRunResult, opts: { manual?: boolean } = {}): Promise<AfterAnalysis> {
  await recordAtsOnJob(ctx, job, r);
  const policy = await getSetting(ctx.db, ctx.userId, 'ats.policy');
  const mode = await getSetting(ctx.db, ctx.userId, 'application.mode');
  const auto = await getSetting(ctx.db, ctx.userId, 'application.autonomous');
  const score = r.parsed.total20;
  const questions = await openQuestions(ctx, r.parsed.missingKeywords, JSON.stringify(r.cv.data));
  const q = (job.qualification ?? {}) as { blockers?: string[]; summary?: string; strengths?: string[]; gaps?: string[] };
  const flags = (job.flags ?? {}) as { injection?: unknown[] };
  const reason = score != null ? `${score}/20 — ${ATS_DECISION_LABELS[r.decision as AtsDecision] ?? ''}` : 'note non lisible dans le rapport';

  // Mode autonome : uniquement si toutes les conditions fixées par l'utilisateur sont réunies,
  // et jamais pour une annonce suspecte ou comportant un point bloquant.
  const autoOk = mode === 'autonomous' && score != null && score >= auto.minAtsScore && (job.priorityScore ?? 0) >= auto.minPriority && !flags.injection?.length && !(q.blockers?.length ?? 0) && !r.parsed.scoreConflict;
  if (autoOk) {
    await setStage(ctx, job.id, 'analyzed', { actor: 'agent:ats', reason, soft: true });
    await setStage(ctx, job.id, 'cv_in_progress', { actor: 'agent:ats', reason: 'mode autonome : conditions réunies', soft: true });
    await enqueue(ctx.db, { type: 'job.tailor', userId: ctx.userId, payload: { jobId: job.id }, idempotencyKey: `job.tailor:${job.id}`, priority: 70, runAfter: ctx.now() });
    return { route: 'auto', questions };
  }

  const wantsReview = score == null || score >= policy.requestFeedbackFrom || job.strategic || job.starred || Boolean(opts.manual);
  await setStage(ctx, job.id, 'analyzed', { actor: 'agent:ats', reason, soft: true });
  if (!wantsReview) return { route: 'archive', questions };
  await setStage(ctx, job.id, 'awaiting_feedback', { actor: 'agent:ats', reason: 'en attente de votre avis', soft: true });
  await raiseAction(ctx.db, {
    userId: ctx.userId,
    type: 'job.review',
    title: `${job.companyName} — ${job.title}`,
    jobId: job.id,
    priority: Math.max(40, Math.min(89, Math.round((job.priorityScore ?? 50) * 0.5 + (score ?? 10) * 2))),
    dedupKey: `job.review:${job.id}`,
    reopen: true,
    body: {
      analysisId: r.analysis.id,
      score,
      decision: r.decision,
      summary: r.parsed.summary || q.summary || '',
      relevance: job.relevanceScore,
      fit: job.fitScore,
      priority: job.priorityScore,
      strategic: job.strategic,
      strengths: q.strengths ?? [],
      gaps: q.gaps ?? [],
      blockers: q.blockers ?? [],
      missingKeywords: r.parsed.missingKeywords.slice(0, 40),
      questions,
      weak: score != null && score < policy.requestFeedbackFrom,
      scoreConflict: Boolean(r.parsed.scoreConflict),
      injection: Boolean(flags.injection?.length),
    },
  });
  return { route: 'review', questions };
}

export interface ReviewInput {
  decision: 'pursue' | 'reject' | 'reanalyze' | 'later';
  /** Réponses aux questions de l'agent : enregistrées une fois pour toutes dans le référentiel. */
  skills?: { name: string; has: boolean; level?: string; context?: string }[];
  /** Correction ou consigne libre, avec sa portée. */
  note?: string;
  noteScope?: 'application' | 'profile' | 'style';
  /** Motif d'un refus : sert à affiner les prochaines sélections. */
  reason?: string;
}

async function saveFeedback(ctx: UserContext, row: { jobId: string | null; kind: string; scope: 'profile' | 'application' | 'style'; text: string; payload?: Record<string, unknown> }) {
  await ctx.db.insert(feedback).values({ id: newId('fb'), userId: ctx.userId, jobId: row.jobId, kind: row.kind, scope: row.scope, text: row.text, payload: row.payload, status: 'applied' });
}

/** Enregistre les précisions de l'utilisateur, selon leur portée. Renvoie le nombre d'informations nouvelles. */
export async function recordFeedback(ctx: UserContext, job: Job, input: Pick<ReviewInput, 'skills' | 'note' | 'noteScope'>): Promise<number> {
  let n = 0;
  for (const s of input.skills ?? []) {
    const name = s.name.trim();
    if (!name) continue;
    await setSkillFact(ctx.db, ctx.userId, { name, has: s.has, level: s.level?.trim() || undefined, context: s.context?.trim() || undefined }, `job:${job.id}`);
    await saveFeedback(ctx, { jobId: job.id, kind: 'skill', scope: 'profile', text: `${name} : ${s.has ? 'oui' : 'non'}${s.context ? ` — ${s.context.trim()}` : ''}`, payload: { ...s, name } });
    n++;
  }
  const note = input.note?.trim();
  if (note) {
    const scope = input.noteScope ?? 'application';
    await saveFeedback(ctx, { jobId: scope === 'application' ? job.id : null, kind: 'correction', scope, text: note, payload: { fromJob: job.id } });
    if (scope === 'style') {
      // Une règle de rédaction s'applique à tous les documents à venir.
      const current = (await getFact(ctx.db, ctx.userId, 'writing.rules'))?.value;
      const rules = Array.isArray(current) ? (current as unknown[]).map(String) : [];
      if (!rules.some((r) => normalize(r) === normalize(note))) await setFact(ctx.db, ctx.userId, { key: 'writing.rules', value: [...rules, note], source: 'user', sourceRef: `job:${job.id}` });
    }
    n++;
  }
  return n;
}

const DECIDABLE = ['new', 'to_analyze', 'analyzed', 'awaiting_feedback', 'filtered', 'abandoned', 'cv_in_progress', 'letter_in_progress', 'ready_to_apply'] as const;

export async function submitReview(ctx: UserContext, jobId: string, input: ReviewInput): Promise<Job> {
  const job = await getJob(ctx, jobId);
  if (isSubmitted(job.stage) || job.stage === 'applying') throw conflict('Une candidature est déjà partie ou en cours pour cette offre.');
  if (!(DECIDABLE as readonly string[]).includes(job.stage)) throw conflict("Cette offre n'attend pas de décision.");
  const added = await recordFeedback(ctx, job, input);
  const now = ctx.now();

  if (input.decision === 'later') {
    const [item] = await ctx.db.select().from(actionItems).where(and(eq(actionItems.userId, ctx.userId), eq(actionItems.dedupKey, `job.review:${job.id}`)));
    if (item && (await getAction(ctx.db, ctx.userId, item.id))) await snoozeAction(ctx.db, ctx.userId, item.id, new Date(now.getTime() + 3 * 86400_000));
    return job;
  }

  if (input.decision === 'reject') {
    const reason = input.reason?.trim() ?? '';
    if (reason) await saveFeedback(ctx, { jobId: job.id, kind: 'job.reject', scope: 'profile', text: `${job.title} (${job.companyName}${job.city ? `, ${job.city}` : ''}) écartée : ${reason}` });
    const updated = await setStage(ctx, job.id, 'abandoned', { actor: 'user', reason: reason || 'écartée par vous', patch: { userDecision: 'rejected', userDecidedAt: now } });
    await resolveActionsFor(ctx.db, ctx.userId, { jobId: job.id, types: ['job.review', 'application.validate'] }, { decision: 'reject' });
    return updated;
  }

  if (input.decision === 'reanalyze') {
    if (job.stage !== 'to_analyze') await setStage(ctx, job.id, 'to_analyze', { actor: 'user', reason: added ? 'nouvelle analyse avec vos précisions' : 'nouvelle analyse demandée', soft: true });
    await enqueue(ctx.db, { type: 'job.ats', userId: ctx.userId, payload: { jobId: job.id, manual: true, force: true }, idempotencyKey: `job.ats:${job.id}`, priority: 90, runAfter: ctx.now() });
    return getJob(ctx, job.id);
  }

  // pursue : la candidature est lancée (CV personnalisé, puis lettre).
  if (!job.latestAnalysisId && job.stage !== 'awaiting_feedback' && job.stage !== 'analyzed') {
    // Offre retenue avant toute analyse : l'analyse de référence est faite d'abord, le CV suit.
    if (job.stage !== 'to_analyze') await setStage(ctx, job.id, 'to_analyze', { actor: 'user', reason: 'retenue par vous', soft: true });
    await ctx.db.update(jobs).set({ userDecision: 'pursue', userDecidedAt: now, starred: true }).where(eq(jobs.id, job.id));
    await enqueue(ctx.db, { type: 'job.ats', userId: ctx.userId, payload: { jobId: job.id, manual: true, thenTailor: true }, idempotencyKey: `job.ats:${job.id}`, priority: 90, runAfter: ctx.now() });
    return getJob(ctx, job.id);
  }
  if (job.stage === 'filtered' || job.stage === 'abandoned') await setStage(ctx, job.id, 'awaiting_feedback', { actor: 'user', reason: 'rétablie par vous' });
  const fresh = await getJob(ctx, job.id);
  if (fresh.stage !== 'analyzed' && fresh.stage !== 'awaiting_feedback') throw badRequest('Les documents de cette candidature sont déjà en préparation.');
  const updated = await setStage(ctx, job.id, 'cv_in_progress', { actor: 'user', reason: 'candidature retenue', patch: { userDecision: 'pursue', userDecidedAt: now } });
  await resolveActionsFor(ctx.db, ctx.userId, { jobId: job.id, types: ['job.review'] }, { decision: 'pursue' });
  await enqueue(ctx.db, { type: 'job.tailor', userId: ctx.userId, payload: { jobId: job.id }, idempotencyKey: `job.tailor:${job.id}`, priority: 85, runAfter: ctx.now() });
  await logActivity(ctx.db, { userId: ctx.userId, actor: 'user', action: 'job.pursued', summary: `${job.companyName} — ${job.title} : candidature lancée`, entityType: 'job', entityId: job.id });
  return updated;
}
