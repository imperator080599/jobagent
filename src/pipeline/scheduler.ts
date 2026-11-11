// Planificateur : à chaque tick, détermine les travaux récurrents arrivés à échéance
// et les place en file. Sans état en mémoire : la dernière exécution est en base,
// ce qui le rend correct en serverless comme après un redémarrage.
import { and, eq, isNull } from 'drizzle-orm';
import type { AppContext } from '../core/context.js';
import { scheduleState, users } from '../db/schema.js';
import { requeueStale } from '../core/queue.js';

export interface RecurringJob {
  name: string;
  /** Renvoie true si le travail est dû pour cet utilisateur à l'instant donné. */
  isDue(ctx: AppContext, userId: string, lastRunAt: Date | null, now: Date): Promise<boolean>;
  /** Place le travail en file (ou l'exécute s'il est instantané). */
  run(ctx: AppContext, userId: string, now: Date): Promise<void>;
}

const jobs: RecurringJob[] = [];

export function registerRecurringJob(job: RecurringJob) {
  jobs.push(job);
}

export async function getLastRun(ctx: AppContext, scope: string, name: string): Promise<Date | null> {
  const [row] = await ctx.db.select().from(scheduleState).where(and(eq(scheduleState.scope, scope), eq(scheduleState.name, name)));
  return row?.lastRunAt ?? null;
}

export async function setLastRun(ctx: AppContext, scope: string, name: string, at: Date): Promise<void> {
  await ctx.db
    .insert(scheduleState)
    .values({ scope, name, lastRunAt: at })
    .onConflictDoUpdate({ target: [scheduleState.scope, scheduleState.name], set: { lastRunAt: at } });
}

export async function schedulerTick(ctx: AppContext): Promise<{ started: string[]; requeued: number }> {
  const now = ctx.now();
  const requeued = await requeueStale(ctx.db, { now });
  const started: string[] = [];
  const active = await ctx.db.select({ id: users.id }).from(users).where(isNull(users.disabledAt));
  for (const u of active) {
    for (const job of jobs) {
      const last = await getLastRun(ctx, u.id, job.name);
      if (!(await job.isDue(ctx, u.id, last, now))) continue;
      // On note l'exécution avant de lancer : un tick concurrent ne relance pas le même travail.
      await setLastRun(ctx, u.id, job.name, now);
      await job.run(ctx, u.id, now);
      started.push(`${job.name}:${u.id}`);
    }
  }
  return { started, requeued };
}
