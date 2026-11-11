// File de tâches persistante (table `tasks`). Garanties :
//  - une seule tâche active par clé d'idempotence (pas de doublon à la reprise) ;
//  - prise atomique (FOR UPDATE SKIP LOCKED) : deux workers ne traitent jamais la même tâche ;
//  - reprise automatique des tâches orphelines (worker interrompu) ;
//  - réessais avec délai croissant, puis échec définitif visible.
import { and, asc, desc, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { tasks } from '../db/schema.js';
import { newId } from '../db/ids.js';

export type Task = typeof tasks.$inferSelect;

export interface EnqueueInput {
  type: string;
  userId: string | null;
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
  runAfter?: Date;
  priority?: number;
  maxAttempts?: number;
}

/** Ajoute une tâche. Retourne null si une tâche active existe déjà pour la même clé d'idempotence. */
export async function enqueue(db: Db, t: EnqueueInput): Promise<Task | null> {
  const values = {
    id: newId('task'),
    userId: t.userId,
    type: t.type,
    payload: t.payload ?? {},
    idempotencyKey: t.idempotencyKey ?? null,
    runAfter: t.runAfter ?? new Date(),
    priority: t.priority ?? 50,
    maxAttempts: t.maxAttempts ?? 4,
  };
  const rows = await db
    .insert(tasks)
    .values(values)
    .onConflictDoNothing({ target: tasks.idempotencyKey, where: sql.raw(`status in ('queued', 'running', 'blocked')`) })
    .returning();
  return rows[0] ?? null;
}

/** Prend la prochaine tâche due. Atomique, sûr en concurrence. */
export async function claimNext(db: Db, opts: { workerId: string; types?: string[]; excludeTypes?: string[]; now?: Date }): Promise<Task | null> {
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const conds = [eq(tasks.status, 'queued'), lte(tasks.runAfter, now)];
    if (opts.types?.length) conds.push(inArray(tasks.type, opts.types));
    if (opts.excludeTypes?.length) conds.push(sql`${tasks.type} not in (${sql.join(opts.excludeTypes.map((t) => sql`${t}`), sql`, `)})`);
    const [next] = await tx
      .select()
      .from(tasks)
      .where(and(...conds))
      .orderBy(desc(tasks.priority), asc(tasks.runAfter), asc(tasks.createdAt))
      .limit(1)
      .for('update', { skipLocked: true });
    if (!next) return null;
    const [claimed] = await tx
      .update(tasks)
      .set({ status: 'running', lockedAt: now, lockedBy: opts.workerId, attempts: next.attempts + 1, startedAt: now })
      .where(eq(tasks.id, next.id))
      .returning();
    return claimed ?? null;
  });
}

export async function completeTask(db: Db, id: string, result?: Record<string, unknown>): Promise<void> {
  await db.update(tasks).set({ status: 'done', finishedAt: new Date(), result: result ?? null, lockedAt: null, lastError: '' }).where(eq(tasks.id, id));
}

/** Échec : replanifie avec un délai croissant, ou marque l'échec définitif après le dernier essai. */
export async function failTask(db: Db, task: Task, error: string, opts: { retry?: boolean; now?: Date } = {}): Promise<'retry' | 'failed'> {
  const now = opts.now ?? new Date();
  const canRetry = opts.retry !== false && task.attempts < task.maxAttempts;
  if (canRetry) {
    const delayMin = Math.min(60, 2 ** task.attempts); // 2, 4, 8, 16… minutes
    await db
      .update(tasks)
      .set({ status: 'queued', lockedAt: null, lockedBy: '', lastError: error.slice(0, 2000), runAfter: new Date(now.getTime() + delayMin * 60_000) })
      .where(eq(tasks.id, task.id));
    return 'retry';
  }
  await db.update(tasks).set({ status: 'failed', finishedAt: now, lockedAt: null, lastError: error.slice(0, 2000) }).where(eq(tasks.id, task.id));
  return 'failed';
}

/** Met la tâche en attente d'une intervention humaine (sans réessai automatique). */
export async function blockTask(db: Db, id: string, reason: string): Promise<void> {
  await db.update(tasks).set({ status: 'blocked', lockedAt: null, lastError: reason.slice(0, 2000) }).where(eq(tasks.id, id));
}

export async function unblockTasks(db: Db, idempotencyKey: string): Promise<number> {
  const rows = await db
    .update(tasks)
    .set({ status: 'queued', runAfter: new Date(), lastError: '' })
    .where(and(eq(tasks.idempotencyKey, idempotencyKey), eq(tasks.status, 'blocked')))
    .returning({ id: tasks.id });
  return rows.length;
}

/** Relance les tâches d'un utilisateur bloquées pour un motif donné (clé d'API ajoutée, CV validé…). */
export async function unblockByReason(db: Db, userId: string, reasons: string[]): Promise<number> {
  if (!reasons.length) return 0;
  const match = sql.join(reasons.map((r) => sql`${tasks.lastError} like ${`[${r}]%`}`), sql` or `);
  const rows = await db
    .update(tasks)
    .set({ status: 'queued', runAfter: new Date(), lastError: '' })
    .where(and(eq(tasks.userId, userId), eq(tasks.status, 'blocked'), sql`(${match})`))
    .returning({ id: tasks.id });
  return rows.length;
}

/** Reprise après interruption : les tâches « en cours » depuis trop longtemps repassent en file. */
export async function requeueStale(db: Db, opts: { olderThanMinutes?: number; now?: Date } = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - (opts.olderThanMinutes ?? 15) * 60_000);
  const rows = await db
    .update(tasks)
    .set({ status: 'queued', lockedAt: null, lockedBy: '', lastError: 'Reprise après interruption du worker' })
    .where(and(eq(tasks.status, 'running'), lt(tasks.lockedAt, cutoff)))
    .returning({ id: tasks.id });
  return rows.length;
}

export async function queueStats(db: Db, userId?: string) {
  const rows = await db
    .select({ status: tasks.status, n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(userId ? eq(tasks.userId, userId) : undefined)
    .groupBy(tasks.status);
  const out: Record<string, number> = { queued: 0, running: 0, done: 0, failed: 0, blocked: 0, cancelled: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}
