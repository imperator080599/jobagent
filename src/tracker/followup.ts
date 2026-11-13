// Relances : quand une candidature reste sans réponse au-delà du délai choisi par
// l'utilisateur, une relance est préparée (brouillon à relire) et proposée dans le
// centre de validation. Rien n'est envoyé. Passé le délai final, la candidature est
// classée « sans réponse » — elle reste rouvrable si une réponse arrive.
import { and, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import type { UserContext } from '../core/context.js';
import { raiseAction } from '../core/inbox.js';
import { getSetting } from '../core/settings.js';
import { applications, jobs } from '../db/schema.js';
import { llmAvailability } from '../llm/index.js';
import { factsMap } from '../profile/facts.js';
import { prepareDraft } from './mail.js';
import { setStage } from './stage.js';

export async function checkFollowUps(ctx: UserContext): Promise<{ due: number; closed: number }> {
  const rules = await getSetting(ctx.db, ctx.userId, 'followup.rules');
  const now = ctx.now();
  const rows = await ctx.db
    .select({ app: applications, job: jobs })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .where(and(eq(applications.userId, ctx.userId), isNotNull(applications.submittedAt), inArray(jobs.stage, ['sent', 'confirmed', 'follow_up_needed'])));
  let due = 0;
  let closed = 0;
  const facts = await factsMap(ctx.db, ctx.userId);
  const signature = String(facts.get('writing.signature')?.value ?? `${facts.get('contact.first_name')?.value ?? ''} ${facts.get('contact.last_name')?.value ?? ''}`).trim();
  for (const { app, job } of rows) {
    const sinceSent = (now.getTime() - app.submittedAt!.getTime()) / 86400_000;
    const sinceActivity = (now.getTime() - (app.lastActivityAt ?? app.submittedAt!).getTime()) / 86400_000;
    // Délai final dépassé sans aucun signe : la candidature est classée, pas supprimée.
    if (sinceSent >= rules.noResponseAfterDays && sinceActivity >= rules.noResponseAfterDays - rules.firstAfterDays) {
      await setStage(ctx, job.id, 'no_response', { actor: 'system', reason: `aucune réponse après ${rules.noResponseAfterDays} jours`, soft: true });
      await ctx.db.update(applications).set({ followUpDueAt: null, outcome: app.outcome || 'no_response', outcomeAt: now }).where(eq(applications.id, app.id));
      closed++;
      continue;
    }
    if (!app.followUpDueAt || app.followUpDueAt.getTime() > now.getTime() || app.followUpCount >= 2) continue;
    due++;
    const n = app.followUpCount + 1;
    let draftId: string | null = null;
    if ((await llmAvailability(ctx)).available) {
      try {
        const draft = await prepareDraft(ctx, { kind: 'follow_up', jobId: job.id, applicationId: app.id, signature, context: `Relance n°${n} d'une candidature restée sans réponse.\nPoste : ${job.title}\nEntreprise : ${job.companyName}\nCandidature envoyée le ${app.submittedAt!.toISOString().slice(0, 10)}${app.channel ? ` via ${app.channel}` : ''}.\nRédige un message de relance bref et courtois, sans reproche, qui rappelle le poste et la date d'envoi.` });
        draftId = draft.id;
      } catch (err) {
        ctx.log.warn('followup_draft_failed', { error: String(err) });
      }
    }
    await setStage(ctx, job.id, 'follow_up_needed', { actor: 'system', reason: `sans réponse depuis ${Math.round(sinceSent)} jours`, soft: true });
    // Prochaine échéance : seconde relance, puis plus rien avant le classement « sans réponse ».
    await ctx.db
      .update(applications)
      .set({ followUpCount: n, followUpDueAt: n === 1 ? new Date(app.submittedAt!.getTime() + rules.secondAfterDays * 86400_000) : null })
      .where(eq(applications.id, app.id));
    await raiseAction(ctx.db, { userId: ctx.userId, type: 'followup.due', title: `Relancer ${job.companyName} — ${job.title}`, body: { text: `Candidature envoyée le ${app.submittedAt!.toISOString().slice(0, 10)}, sans réponse depuis. ${draftId ? 'Un brouillon de relance est prêt à être relu.' : 'Vous pouvez préparer une relance.'}`, link: '/suivi', draftId }, jobId: job.id, applicationId: app.id, priority: 72, dedupKey: `followup:${app.id}:${n}` });
  }
  return { due, closed };
}

/** Candidatures dont une relance est due (pour l'affichage). */
export async function dueFollowUps(ctx: UserContext) {
  return ctx.db
    .select({ jobId: jobs.id, title: jobs.title, companyName: jobs.companyName, submittedAt: applications.submittedAt, followUpDueAt: applications.followUpDueAt, followUpCount: applications.followUpCount })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .where(and(eq(applications.userId, ctx.userId), isNotNull(applications.followUpDueAt), lte(applications.followUpDueAt, ctx.now())));
}
