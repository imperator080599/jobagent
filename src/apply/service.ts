// Candidature : contrôle avant envoi, validation des documents, enregistrement de l'envoi.
// Règles tenues par le code :
//  - une seule candidature par offre (contrainte en base) et jamais de seconde
//    candidature pour une offre jumelle déjà traitée (CHECK_EXISTING_JOB) ;
//  - aucun document non validé ne part ;
//  - une candidature n'est « envoyée » que sur déclaration de l'utilisateur ou
//    preuve d'envoi, et « confirmée » uniquement avec un accusé de réception réel.
import { and, desc, eq } from 'drizzle-orm';
import type { UserContext } from '../core/context.js';
import { logActivity } from '../core/activity.js';
import { badRequest, conflict } from '../core/errors.js';
import { raiseAction, resolveActionsFor } from '../core/inbox.js';
import { getSetting } from '../core/settings.js';
import { newId } from '../db/ids.js';
import { applications, cvVersions, letters } from '../db/schema.js';
import { getFactValue } from '../profile/facts.js';
import { checkExistingJob } from '../search/ingest.js';
import { isSubmitted } from '../shared/stages.js';
import { getJob, setStage, type Job } from '../tracker/stage.js';

export type Application = typeof applications.$inferSelect;

export interface QaCheck {
  id: string;
  ok: boolean;
  severity: 'error' | 'warning';
  message: string;
}

export interface ApplicationPack {
  job: Job;
  cv: typeof cvVersions.$inferSelect | null;
  letter: typeof letters.$inferSelect | null;
  application: Application | null;
  qa: { ok: boolean; checks: QaCheck[] };
}

type Render = { ok?: boolean | null; checks?: { id: string; ok: boolean; severity: string; message: string }[] };

/** Contrôle qualité avant candidature : tout ce qui pourrait rendre l'envoi fautif, incohérent ou en double. */
export async function buildPack(ctx: UserContext, jobId: string): Promise<ApplicationPack> {
  const job = await getJob(ctx, jobId);
  const [cv] = await ctx.db.select().from(cvVersions).where(and(eq(cvVersions.userId, ctx.userId), eq(cvVersions.jobId, jobId), eq(cvVersions.kind, 'application'))).orderBy(desc(cvVersions.createdAt)).limit(1);
  const [letter] = await ctx.db.select().from(letters).where(and(eq(letters.userId, ctx.userId), eq(letters.jobId, jobId), eq(letters.kind, 'application'))).orderBy(desc(letters.createdAt)).limit(1);
  const [application] = await ctx.db.select().from(applications).where(and(eq(applications.userId, ctx.userId), eq(applications.jobId, jobId)));
  const checks: QaCheck[] = [];
  const add = (id: string, ok: boolean, severity: QaCheck['severity'], message: string) => checks.push({ id, ok, severity, message });
  const now = ctx.now();

  // 1. Doublon : une offre jumelle a-t-elle déjà reçu une candidature ?
  const twin = await checkExistingJob(ctx, job, { excludeId: job.id });
  add('duplicate', !twin.alreadyApplied, 'error', twin.alreadyApplied ? `Vous avez déjà postulé à cette offre via une autre annonce (${twin.job!.companyName} — ${twin.job!.title}).` : 'Aucune candidature antérieure pour cette offre.');
  add('not_sent', !isSubmitted(job.stage), 'error', isSubmitted(job.stage) ? 'Une candidature est déjà partie pour cette offre.' : "Cette offre n'a pas encore reçu de candidature.");

  // 2. L'offre est-elle toujours ouverte ?
  const expired = Boolean(job.expiredAt) || job.stage === 'expired';
  add('open', !expired, 'error', expired ? "L'offre n'est plus en ligne." : "L'offre est toujours en ligne (dernière observation prise en compte).");
  if (job.deadlineAt) add('deadline', job.deadlineAt.getTime() > now.getTime(), 'error', job.deadlineAt.getTime() > now.getTime() ? `Date limite : ${job.deadlineAt.toISOString().slice(0, 10)}.` : `La date limite (${job.deadlineAt.toISOString().slice(0, 10)}) est dépassée.`);

  // 3. Documents : présents, rendus et contrôlés.
  const cvRender = ((cv?.checks ?? {}) as { render?: Render }).render;
  add('cv', Boolean(cv), 'error', cv ? `CV personnalisé prêt (${cv.changeSummary || 'version du master'}).` : 'Aucun CV préparé pour cette offre.');
  if (cv) {
    add('cv_render', cvRender?.ok === true, cvRender?.ok === false ? 'error' : 'warning', cvRender?.ok === true ? 'CV : mise en page contrôlée sur le PDF final.' : cvRender?.ok === false ? `CV : ${(cvRender.checks ?? []).filter((c) => !c.ok).map((c) => c.message).join(' ') || 'le rendu présente une anomalie.'}` : "CV : le PDF n'a pas encore été produit.");
  }
  const letterChecks = (letter?.checks ?? {}) as { render?: Render; truthfulness?: { ok: boolean; issues: string[] } };
  add('letter', Boolean(letter), 'warning', letter ? 'Lettre de motivation prête.' : 'Aucune lettre préparée (facultative selon les offres).');
  if (letter) {
    add('letter_render', letterChecks.render?.ok === true, letterChecks.render?.ok === false ? 'error' : 'warning', letterChecks.render?.ok === true ? 'Lettre : mise en page contrôlée sur le PDF final.' : letterChecks.render?.ok === false ? `Lettre : ${(letterChecks.render.checks ?? []).filter((c) => !c.ok).map((c) => c.message).join(' ') || 'le rendu présente une anomalie.'}` : "Lettre : le PDF n'a pas encore été produit.");
    add('letter_truth', letterChecks.truthfulness?.ok !== false, 'error', letterChecks.truthfulness?.ok === false ? `Lettre : ${letterChecks.truthfulness.issues.length} affirmation(s) à vérifier.` : 'Lettre : aucune affirmation non étayée détectée.');
    // La lettre s'adresse-t-elle à la bonne entreprise ?
    const body = letter.text.toLowerCase();
    const firstWord = job.companyName.toLowerCase().split(/\s+/)[0] ?? '';
    add('letter_company', !firstWord || body.includes(firstWord) || JSON.stringify(letter.content).toLowerCase().includes(firstWord), 'error', "La lettre mentionne bien l'entreprise visée.");
  }

  // 4. Coordonnées : l'adresse de candidature choisie par l'utilisateur figure sur les documents.
  const email = (await getFactValue<string>(ctx.db, ctx.userId, 'contact.email'))?.trim().toLowerCase();
  if (cv && email) {
    const onCv = cv.data.identity.email.trim().toLowerCase();
    add('email', !onCv || onCv === email, 'warning', !onCv || onCv === email ? `Adresse de candidature : ${email}.` : `Le CV porte l'adresse ${onCv}, différente de votre adresse de candidature (${email}).`);
  }
  if (!job.applyUrl && !job.canonicalUrl) add('apply_url', false, 'warning', "Aucune adresse de candidature n'est connue pour cette offre.");
  const flags = (job.flags ?? {}) as { injection?: unknown[]; contentChangedAt?: string };
  if (flags.injection?.length) add('injection', false, 'warning', "L'annonce contient un texte adressé à une IA : relisez-la avant de postuler.");
  if (flags.contentChangedAt) add('changed', false, 'warning', `L'annonce a été modifiée le ${flags.contentChangedAt.slice(0, 10)} : vérifiez que vos documents correspondent toujours.`);
  return { job, cv: cv ?? null, letter: letter ?? null, application: application ?? null, qa: { ok: checks.every((c) => c.ok || c.severity !== 'error'), checks } };
}

/** L'utilisateur valide les documents : ils deviennent définitifs pour cette candidature. */
export async function approveApplication(ctx: UserContext, jobId: string, opts: { withoutLetter?: boolean } = {}): Promise<ApplicationPack> {
  const pack = await buildPack(ctx, jobId);
  const { job, cv, letter } = pack;
  if (!['ready_to_apply', 'letter_in_progress'].includes(job.stage)) throw conflict("Cette candidature n'est pas prête à être validée.");
  if (!cv) throw badRequest('Aucun CV à valider pour cette offre.');
  const blocking = pack.qa.checks.filter((c) => !c.ok && c.severity === 'error' && !(opts.withoutLetter && c.id.startsWith('letter')));
  if (blocking.length) throw conflict(`Validation impossible : ${blocking.map((c) => c.message).join(' ')}`, { checks: blocking });
  const now = ctx.now();
  await ctx.db.update(cvVersions).set({ status: 'approved', approvedAt: now }).where(eq(cvVersions.id, cv.id));
  if (letter && !opts.withoutLetter) await ctx.db.update(letters).set({ status: 'approved', approvedAt: now }).where(eq(letters.id, letter.id));
  const values = { cvVersionId: cv.id, letterId: opts.withoutLetter ? null : (letter?.id ?? null), mode: 'manual' as const, applyUrl: job.applyUrl || job.canonicalUrl, qaReport: pack.qa as unknown as Record<string, unknown>, preparedAt: now, authorizedAt: now, authorizedBy: 'user', updatedAt: now };
  await ctx.db
    .insert(applications)
    .values({ id: newId('app'), userId: ctx.userId, jobId, ...values })
    .onConflictDoUpdate({ target: [applications.userId, applications.jobId], set: values });
  if (job.stage !== 'ready_to_apply') await setStage(ctx, jobId, 'ready_to_apply', { actor: 'user', reason: 'documents validés', soft: true });
  await resolveActionsFor(ctx.db, ctx.userId, { jobId, types: ['application.validate'] }, { approved: true });
  await raiseAction(ctx.db, {
    userId: ctx.userId,
    type: 'application.submit',
    title: `Postuler : ${job.companyName} — ${job.title}`,
    jobId,
    priority: 84,
    dedupKey: `application.submit:${jobId}`,
    reopen: true,
    body: { applyUrl: values.applyUrl, cvPdfFileId: cv.pdfFileId, cvDocxFileId: cv.docxFileId, letterPdfFileId: opts.withoutLetter ? null : (letter?.pdfFileId ?? null), letterDocxFileId: opts.withoutLetter ? null : (letter?.docxFileId ?? null), deadlineAt: job.deadlineAt },
  });
  await logActivity(ctx.db, { userId: ctx.userId, actor: 'user', action: 'application.approved', summary: `${job.companyName} — ${job.title} : documents validés`, entityType: 'job', entityId: jobId, data: { cvVersionId: cv.id, letterId: values.letterId } });
  return buildPack(ctx, jobId);
}

export interface SubmissionInput {
  /** Canal utilisé : site de l'entreprise, email, LinkedIn… */
  channel?: string;
  appliedAt?: string;
  /** Preuve de réception (texte de confirmation, numéro de dossier, adresse de la page). Sans elle, la candidature est « envoyée », pas « confirmée ». */
  confirmationText?: string;
  confirmationUrl?: string;
  notes?: string;
}

/** Enregistre l'envoi déclaré par l'utilisateur (candidature faite à la main ou assistée). */
export async function recordSubmission(ctx: UserContext, jobId: string, input: SubmissionInput): Promise<ApplicationPack> {
  const job = await getJob(ctx, jobId);
  if (isSubmitted(job.stage)) throw conflict('Cette candidature est déjà enregistrée comme envoyée.');
  const twin = await checkExistingJob(ctx, job, { excludeId: job.id });
  if (twin.alreadyApplied) throw conflict(`Candidature en double : ${twin.summary}`, { jobId: twin.job!.id });
  const now = ctx.now();
  const sentAt = input.appliedAt ? new Date(input.appliedAt) : now;
  if (Number.isNaN(sentAt.getTime()) || sentAt.getTime() > now.getTime() + 86400_000) throw badRequest("Date d'envoi invalide.");
  const rules = await getSetting(ctx.db, ctx.userId, 'followup.rules');
  const proof = input.confirmationText?.trim() || input.confirmationUrl?.trim();
  const [existing] = await ctx.db.select().from(applications).where(and(eq(applications.userId, ctx.userId), eq(applications.jobId, jobId)));
  const values = {
    mode: existing?.mode ?? ('manual' as const),
    channel: input.channel?.trim() || existing?.channel || '',
    applyUrl: existing?.applyUrl || job.applyUrl || job.canonicalUrl,
    submittedAt: sentAt,
    confirmation: proof ? ({ text: input.confirmationText?.trim() ?? '', url: input.confirmationUrl?.trim() ?? '', source: 'user', at: now.toISOString() } as Record<string, unknown>) : null,
    confirmedAt: proof ? now : null,
    lastActivityAt: sentAt,
    followUpDueAt: new Date(sentAt.getTime() + rules.firstAfterDays * 86400_000),
    notes: input.notes?.trim() || existing?.notes || '',
    updatedAt: now,
  };
  await ctx.db
    .insert(applications)
    .values({ id: newId('app'), userId: ctx.userId, jobId, ...values })
    .onConflictDoUpdate({ target: [applications.userId, applications.jobId], set: values });
  await setStage(ctx, jobId, 'sent', { actor: 'user', reason: values.channel ? `envoyée via ${values.channel}` : 'envoyée', patch: { userDecision: 'pursue', userDecidedAt: job.userDecidedAt ?? now } });
  if (proof) await setStage(ctx, jobId, 'confirmed', { actor: 'user', reason: 'accusé de réception fourni' });
  await resolveActionsFor(ctx.db, ctx.userId, { jobId, types: ['application.submit', 'application.validate', 'job.review'] }, { submitted: true });
  await logActivity(ctx.db, { userId: ctx.userId, actor: 'user', action: 'application.submitted', summary: `${job.companyName} — ${job.title} : candidature envoyée${proof ? ' (accusé de réception enregistré)' : ''}`, entityType: 'job', entityId: jobId });
  return buildPack(ctx, jobId);
}
