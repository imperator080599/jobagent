// Tâches du pipeline d'une offre : qualification → analyse ATS → (avis de
// l'utilisateur) → CV personnalisé → lettre → validation. Chaque tâche vérifie le
// statut de l'offre avant d'agir : rejouée ou exécutée en double, elle ne fait rien.
import { and, desc, eq } from 'drizzle-orm';
import type { UserContext } from '../core/context.js';
import { ConfigError, NeedsHumanError } from '../core/errors.js';
import { raiseAction, resolveActionsFor } from '../core/inbox.js';
import { enqueue } from '../core/queue.js';
import { cvVersions, jobs, letters } from '../db/schema.js';
import { FetchError } from '../search/http.js';
import { descriptionHash } from '../search/normalize.js';
import { fetchJobPage } from '../search/page.js';
import { htmlToText } from '../search/normalize.js';
import { isSubmitted } from '../shared/stages.js';
import { getJob, setStage, type Job } from '../tracker/stage.js';
import { tailorCv } from '../writer/tailor.js';
import { writeLetter } from '../writer/letter.js';
import { latestAnalysis, runAtsAnalysis, type AtsParsed } from './ats.js';
import { masterFor } from './brief.js';
import { refreshQualification, runQualification } from './qualify.js';
import { afterAnalysis } from './review.js';
import { registerTaskHandler } from './worker.js';

const payloadOf = (p: unknown) => (p ?? {}) as { jobId?: string; manual?: boolean; force?: boolean; thenTailor?: boolean; requalify?: boolean; instructions?: string };

/** Signale à l'utilisateur ce qui manque avant de laisser la tâche en attente. */
async function explain(ctx: UserContext, err: unknown) {
  if (!(err instanceof ConfigError)) return;
  if (err.what === 'letter_template_missing') {
    await raiseAction(ctx.db, { userId: ctx.userId, type: 'setup.letter_template', title: 'Importer votre modèle de lettre', body: { text: 'Vos lettres sont rédigées dans votre propre modèle (Word ou RTF). Importez-le pour que les candidatures en attente reprennent.', link: '/profil/cv' }, priority: 92, dedupKey: 'setup.letter_template', reopen: true });
  }
  if (err.what === 'cv_master_missing') {
    await raiseAction(ctx.db, { userId: ctx.userId, type: 'setup.cv_master', title: 'Importer votre CV master', body: { text: 'Des offres attendent votre CV de référence pour être analysées.', link: '/profil/cv' }, priority: 100, dedupKey: 'setup.cv_master', reopen: true });
  }
}

registerTaskHandler('job.qualify', async (ctx, task) => {
  const p = payloadOf(task.payload);
  if (!p.jobId) return { skipped: 'no_job' };
  try {
    const out = await runQualification(ctx, p.jobId, { manual: p.manual });
    return { decision: out.decision, reason: out.reason, relevance: out.qualification?.relevance, fit: out.qualification?.fit };
  } catch (err) {
    await explain(ctx, err);
    throw err;
  }
});

/**
 * Certaines sources ne fournissent qu'un extrait de l'annonce. Une analyse ATS sur un
 * extrait serait trompeuse : le texte complet est d'abord lu sur la page d'origine
 * (si le site le permet), sinon il est demandé à l'utilisateur.
 */
async function ensureFullText(ctx: UserContext, job: Job): Promise<Job> {
  const flags = (job.flags ?? {}) as Record<string, unknown>;
  if (!flags.partialDescription) return job;
  const url = job.applyUrl || job.canonicalUrl;
  if (url) {
    try {
      const page = await fetchJobPage(ctx, url);
      const text = page.job?.descriptionText?.trim() ? htmlToText(page.job.descriptionText) : page.job?.descriptionHtml ? htmlToText(page.job.descriptionHtml) : '';
      if (text.length >= 600 && text.length > job.descriptionText.length * 1.4) {
        const next = { ...flags };
        delete next.partialDescription;
        const [updated] = await ctx.db.update(jobs).set({ descriptionText: text, descriptionHash: descriptionHash(text), flags: next, updatedAt: ctx.now() }).where(eq(jobs.id, job.id)).returning();
        return updated ?? job;
      }
    } catch (err) {
      if (!(err instanceof FetchError)) throw err;
    }
  }
  await raiseAction(ctx.db, { userId: ctx.userId, type: 'job.needs_text', title: `Texte de l'annonce à compléter : ${job.companyName} — ${job.title}`, body: { text: "Cette source ne fournit qu'un extrait de l'annonce et le site d'origine ne permet pas de la lire automatiquement. Ouvrez l'annonce, copiez son texte complet et collez-le dans la fiche : l'analyse ATS reprendra aussitôt.", link: `/offres/${job.id}` }, jobId: job.id, priority: 60, dedupKey: `job.needs_text:${job.id}` });
  throw new NeedsHumanError("Texte complet de l'annonce indisponible.", 'job_text_missing');
}

registerTaskHandler('job.ats', async (ctx, task) => {
  const p = payloadOf(task.payload);
  if (!p.jobId) return { skipped: 'no_job' };
  const job = await getJob(ctx, p.jobId);
  if (!['to_analyze', 'analyzed', 'awaiting_feedback'].includes(job.stage)) return { skipped: `statut ${job.stage}` };
  try {
    let full = await ensureFullText(ctx, job);
    if (p.requalify) full = await refreshQualification(ctx, full);
    const result = await runAtsAnalysis(ctx, { job: full, force: p.force });
    // Analyse identique déjà faite et déjà présentée : rien ne change, rien n'est rejoué.
    if (result.reused && job.latestAnalysisId === result.analysis.id && job.stage !== 'to_analyze' && !p.thenTailor) return { score: result.parsed.total20, decision: result.decision, route: 'unchanged', reused: true };
    const next = await afterAnalysis(ctx, await getJob(ctx, job.id), result, { manual: p.manual });
    if (p.thenTailor && next.route !== 'auto') {
      // Offre déjà retenue par l'utilisateur : la préparation des documents s'enchaîne.
      await setStage(ctx, job.id, 'cv_in_progress', { actor: 'user', reason: 'candidature retenue', soft: true });
      await resolveActionsFor(ctx.db, ctx.userId, { jobId: job.id, types: ['job.review'] }, { decision: 'pursue' });
      await enqueue(ctx.db, { type: 'job.tailor', userId: ctx.userId, payload: { jobId: job.id }, idempotencyKey: `job.tailor:${job.id}`, priority: 85, runAfter: ctx.now() });
    }
    return { score: result.parsed.total20, decision: result.decision, route: next.route, reused: result.reused };
  } catch (err) {
    await explain(ctx, err);
    await explainAts(ctx, job, err);
    throw err;
  }
});

const ATS_PROBLEMS: Record<string, string> = {
  ats_prompt_integrity: "Votre prompt ATS n'a pas pu être transmis à l'identique : l'analyse n'a pas été lancée. Vérifiez la version active (Profil → Prompt ATS), puis relancez.",
  ats_input_too_large: "Le prompt, le CV et l'annonce dépassent ce que le modèle peut lire en une fois. Rien n'a été coupé : l'analyse attend votre décision.",
  ats_unusable: "Le rapport ATS est incomplet ou n'a pas été transmis tel quel : il est conservé, mais aucune décision n'a été prise à partir de lui. Relancez l'analyse.",
};

/** Les problèmes d'analyse ATS apparaissent dans le centre de validation, avec leur cause exacte. */
async function explainAts(ctx: UserContext, job: Job, err: unknown) {
  if (!(err instanceof NeedsHumanError) || !ATS_PROBLEMS[err.reason]) return;
  await raiseAction(ctx.db, { userId: ctx.userId, type: 'job.ats_problem', title: `Analyse ATS à vérifier : ${job.companyName} — ${job.title}`, body: { text: ATS_PROBLEMS[err.reason], detail: err.message, link: `/offres/${job.id}` }, jobId: job.id, priority: 75, dedupKey: `job.ats_problem:${job.id}`, reopen: true });
}

registerTaskHandler('job.tailor', async (ctx, task) => {
  const p = payloadOf(task.payload);
  if (!p.jobId) return { skipped: 'no_job' };
  const job = await getJob(ctx, p.jobId);
  if (job.stage !== 'cv_in_progress') return { skipped: `statut ${job.stage}` };
  try {
    const master = await masterFor(ctx, job.language || undefined);
    const reference = await latestAnalysis(ctx, job.id, master.id);
    const run = await tailorCv(ctx, job, { master, analysis: (reference?.parsed as unknown as AtsParsed) ?? null, instructions: p.instructions });
    // Le CV personnalisé repasse par le même prompt ATS : le gain réel est mesuré, pas supposé.
    let after: number | null = null;
    if (run.changes.length && run.render.ok !== false) {
      const fresh = (await ctx.db.select().from(cvVersions).where(eq(cvVersions.id, run.cv.id)))[0]!;
      try {
        after = (await runAtsAnalysis(ctx, { job, cv: fresh })).parsed.total20;
      } catch (err) {
        if (err instanceof ConfigError) throw err;
        ctx.log.warn('ats_rescore_failed', { error: String(err) });
      }
    }
    await ctx.db
      .update(cvVersions)
      .set({ checks: { ...((await ctx.db.select({ checks: cvVersions.checks }).from(cvVersions).where(eq(cvVersions.id, run.cv.id)))[0]?.checks ?? {}), ats: { before: reference?.score ?? job.atsScore ?? null, after }, keywordsIntegrated: run.keywordsIntegrated, keywordsSkipped: run.keywordsSkipped, notes: run.notes, revertedForLayout: run.revertedForLayout } })
      .where(eq(cvVersions.id, run.cv.id));
    await setStage(ctx, job.id, 'letter_in_progress', { actor: 'agent:cv', reason: run.cv.changeSummary, soft: true });
    await enqueue(ctx.db, { type: 'job.letter', userId: ctx.userId, payload: { jobId: job.id }, idempotencyKey: `job.letter:${job.id}`, priority: 85, runAfter: ctx.now() });
    return { cvVersionId: run.cv.id, changes: run.changes.length, rejected: run.rejected.length, renderOk: run.render.ok, atsAfter: after };
  } catch (err) {
    await explain(ctx, err);
    throw err;
  }
});

/** Présente les documents prêts dans le centre de validation. Rien n'est envoyé à ce stade. */
export async function raiseValidation(ctx: UserContext, jobId: string): Promise<void> {
  const job = await getJob(ctx, jobId);
  const [cv] = await ctx.db.select().from(cvVersions).where(and(eq(cvVersions.userId, ctx.userId), eq(cvVersions.jobId, jobId), eq(cvVersions.kind, 'application'))).orderBy(desc(cvVersions.createdAt)).limit(1);
  const [letter] = await ctx.db.select().from(letters).where(and(eq(letters.userId, ctx.userId), eq(letters.jobId, jobId), eq(letters.kind, 'application'))).orderBy(desc(letters.createdAt)).limit(1);
  const cvChecks = (cv?.checks ?? {}) as { render?: { ok?: boolean | null; previewFileId?: string | null; checks?: { ok: boolean; severity: string; message: string }[] }; ats?: { before: number | null; after: number | null } };
  const letterChecks = (letter?.checks ?? {}) as { render?: { ok?: boolean | null; previewFileId?: string | null; checks?: { ok: boolean; severity: string; message: string }[] }; truthfulness?: { ok: boolean; issues: string[] }; notes?: string };
  const provenance = (cv?.provenance ?? {}) as { changes?: unknown[]; rejected?: unknown[] };
  const problems = [
    ...(cvChecks.render?.checks ?? []).filter((c) => !c.ok).map((c) => `CV : ${c.message}`),
    ...(letterChecks.render?.checks ?? []).filter((c) => !c.ok).map((c) => `Lettre : ${c.message}`),
    ...(letterChecks.truthfulness?.issues ?? []).map((i) => `Lettre : ${i}`),
  ];
  await raiseAction(ctx.db, {
    userId: ctx.userId,
    type: 'application.validate',
    title: `Valider la candidature : ${job.companyName} — ${job.title}`,
    jobId,
    priority: problems.length ? 88 : 86,
    dedupKey: `application.validate:${jobId}`,
    reopen: true,
    body: {
      cvVersionId: cv?.id ?? null,
      cvPdfFileId: cv?.pdfFileId ?? null,
      cvPreviewFileId: cvChecks.render?.previewFileId ?? null,
      cvSummary: cv?.changeSummary ?? '',
      cvChanges: provenance.changes ?? [],
      cvRejected: provenance.rejected ?? [],
      ats: cvChecks.ats ?? { before: job.atsScore, after: null },
      letterId: letter?.id ?? null,
      letterPdfFileId: letter?.pdfFileId ?? null,
      letterPreviewFileId: letterChecks.render?.previewFileId ?? null,
      letterNotes: letterChecks.notes ?? '',
      problems,
      documentsPending: cvChecks.render?.ok == null || letterChecks.render?.ok == null,
    },
  });
}

registerTaskHandler('job.letter', async (ctx, task) => {
  const p = payloadOf(task.payload);
  if (!p.jobId) return { skipped: 'no_job' };
  const job = await getJob(ctx, p.jobId);
  if (isSubmitted(job.stage) || job.stage !== 'letter_in_progress') return { skipped: `statut ${job.stage}` };
  try {
    const master = await masterFor(ctx, job.language || undefined);
    const [cv] = await ctx.db.select({ id: cvVersions.id }).from(cvVersions).where(and(eq(cvVersions.userId, ctx.userId), eq(cvVersions.jobId, job.id), eq(cvVersions.kind, 'application'))).orderBy(desc(cvVersions.createdAt)).limit(1);
    const run = await writeLetter(ctx, job, { master, cvVersionId: cv?.id ?? null, instructions: p.instructions });
    await setStage(ctx, job.id, 'ready_to_apply', { actor: 'agent:letter', reason: `lettre rédigée (${run.words} mots)`, soft: true });
    await raiseValidation(ctx, job.id);
    return { letterId: run.letter.id, words: run.words, issues: run.issues.length, renderOk: run.render.ok };
  } catch (err) {
    await explain(ctx, err);
    throw err;
  }
});
