// Changement de statut d'une opportunité. Point de passage unique : chaque
// transition est validée, datée et historisée, et une candidature déjà partie
// ne peut jamais revenir à un statut antérieur à l'envoi.
import { and, asc, eq } from 'drizzle-orm';
import type { UserContext } from '../core/context.js';
import { conflict, notFound } from '../core/errors.js';
import { logActivity } from '../core/activity.js';
import { newId } from '../db/ids.js';
import { jobs, stageHistory } from '../db/schema.js';
import { canTransition, STAGE_LABELS, type Stage } from '../shared/stages.js';

export type Job = typeof jobs.$inferSelect;

export async function getJob(ctx: UserContext, id: string): Promise<Job> {
  const [job] = await ctx.db.select().from(jobs).where(and(eq(jobs.id, id), eq(jobs.userId, ctx.userId)));
  if (!job) throw notFound('Offre introuvable.');
  return job;
}

export interface StageChange {
  actor: string; // 'user' | 'system' | 'agent:<nom>'
  reason?: string;
  /** Champs de l'offre à mettre à jour dans la même écriture. */
  patch?: Partial<typeof jobs.$inferInsert>;
  /** Ne lève pas d'erreur si la transition est interdite : l'offre est rendue inchangée. */
  soft?: boolean;
}

/**
 * Applique une transition. Écriture conditionnelle sur le statut d'origine : si deux
 * traitements se croisent, un seul l'emporte et l'autre est refusé (jamais d'écrasement).
 */
export async function setStage(ctx: UserContext, jobId: string, to: Stage, change: StageChange): Promise<Job> {
  const job = await getJob(ctx, jobId);
  if (job.stage === to) {
    if (change.patch && Object.keys(change.patch).length) {
      const [updated] = await ctx.db.update(jobs).set({ ...change.patch, updatedAt: ctx.now() }).where(eq(jobs.id, job.id)).returning();
      return updated ?? job;
    }
    return job;
  }
  if (!canTransition(job.stage, to)) {
    if (change.soft) return job;
    throw conflict(`Passage de « ${STAGE_LABELS[job.stage]} » à « ${STAGE_LABELS[to]} » impossible.`);
  }
  const now = ctx.now();
  const [updated] = await ctx.db
    .update(jobs)
    .set({ ...change.patch, stage: to, stageChangedAt: now, updatedAt: now })
    .where(and(eq(jobs.id, job.id), eq(jobs.stage, job.stage)))
    .returning();
  if (!updated) {
    if (change.soft) return getJob(ctx, jobId);
    throw conflict("Le statut de l'offre a changé entre-temps. Rechargez la page.");
  }
  await ctx.db.insert(stageHistory).values({ id: newId('stg'), userId: ctx.userId, jobId: job.id, fromStage: job.stage, toStage: to, actor: change.actor, reason: change.reason ?? '', at: now });
  await logActivity(ctx.db, {
    userId: ctx.userId,
    actor: change.actor,
    action: 'job.stage',
    summary: `${job.companyName} — ${job.title} : ${STAGE_LABELS[to]}${change.reason ? ` (${change.reason})` : ''}`,
    entityType: 'job',
    entityId: job.id,
    data: { from: job.stage, to },
  });
  return updated;
}

export async function listStageHistory(ctx: UserContext, jobId: string) {
  return ctx.db.select().from(stageHistory).where(and(eq(stageHistory.jobId, jobId), eq(stageHistory.userId, ctx.userId))).orderBy(asc(stageHistory.at));
}
