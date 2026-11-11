// Centre de validation : toutes les demandes d'intervention de l'utilisateur passent
// par ici. Chaque demande porte une clé d'unicité : une question déjà posée (même
// traitée ou écartée) n'est jamais reposée.
import { and, asc, desc, eq, inArray, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { actionItems } from '../db/schema.js';
import { newId } from '../db/ids.js';

export type ActionItem = typeof actionItems.$inferSelect;

export interface RaiseActionInput {
  userId: string;
  type: string;
  title: string;
  body?: Record<string, unknown>;
  jobId?: string | null;
  applicationId?: string | null;
  /** 0-100 : plus la valeur est haute, plus la demande remonte dans la file. */
  priority?: number;
  dedupKey: string;
  /** Rouvre la demande si elle avait déjà été traitée (cas d'un état qui se reproduit, ex. source de nouveau en panne). */
  reopen?: boolean;
}

export async function raiseAction(db: Db, a: RaiseActionInput): Promise<ActionItem | null> {
  const values = {
    id: newId('todo'),
    userId: a.userId,
    type: a.type,
    title: a.title,
    body: a.body ?? {},
    jobId: a.jobId ?? null,
    applicationId: a.applicationId ?? null,
    priority: a.priority ?? 50,
    dedupKey: a.dedupKey,
  };
  const inserted = await db.insert(actionItems).values(values).onConflictDoNothing({ target: [actionItems.userId, actionItems.dedupKey] }).returning();
  if (inserted[0]) return inserted[0];
  const [existing] = await db.select().from(actionItems).where(and(eq(actionItems.userId, a.userId), eq(actionItems.dedupKey, a.dedupKey)));
  if (!existing) return null;
  if (existing.status === 'open' || existing.status === 'snoozed') {
    // Demande déjà en attente : on rafraîchit son contenu sans la dupliquer.
    const [updated] = await db.update(actionItems).set({ title: a.title, body: a.body ?? existing.body, priority: a.priority ?? existing.priority }).where(eq(actionItems.id, existing.id)).returning();
    return updated ?? existing;
  }
  if (a.reopen) {
    const [reopened] = await db
      .update(actionItems)
      .set({ status: 'open', title: a.title, body: a.body ?? {}, priority: a.priority ?? existing.priority, resolvedAt: null, resolution: null, createdAt: new Date() })
      .where(eq(actionItems.id, existing.id))
      .returning();
    return reopened ?? null;
  }
  return null;
}

export async function resolveAction(db: Db, userId: string, ref: { id?: string; dedupKey?: string }, resolution: Record<string, unknown> = {}, status: 'done' | 'dismissed' = 'done'): Promise<number> {
  const cond = ref.id ? eq(actionItems.id, ref.id) : eq(actionItems.dedupKey, ref.dedupKey ?? '');
  const rows = await db
    .update(actionItems)
    .set({ status, resolvedAt: new Date(), resolution })
    .where(and(eq(actionItems.userId, userId), cond, inArray(actionItems.status, ['open', 'snoozed'])))
    .returning({ id: actionItems.id });
  return rows.length;
}

/** Clôt toutes les demandes ouvertes d'un type donné pour un objet (ex. l'offre a été abandonnée). */
export async function resolveActionsFor(db: Db, userId: string, filter: { jobId?: string; types?: string[]; dedupPrefix?: string }, resolution: Record<string, unknown> = {}): Promise<number> {
  const conds = [eq(actionItems.userId, userId), inArray(actionItems.status, ['open', 'snoozed'])];
  if (filter.jobId) conds.push(eq(actionItems.jobId, filter.jobId));
  if (filter.types?.length) conds.push(inArray(actionItems.type, filter.types));
  if (filter.dedupPrefix) conds.push(sql`${actionItems.dedupKey} like ${`${filter.dedupPrefix}%`}`);
  const rows = await db.update(actionItems).set({ status: 'done', resolvedAt: new Date(), resolution }).where(and(...conds)).returning({ id: actionItems.id });
  return rows.length;
}

export async function snoozeAction(db: Db, userId: string, id: string, until: Date): Promise<void> {
  await db.update(actionItems).set({ status: 'snoozed', snoozeUntil: until }).where(and(eq(actionItems.userId, userId), eq(actionItems.id, id)));
}

export async function listOpenActions(db: Db, userId: string, opts: { now?: Date; limit?: number; types?: string[] } = {}): Promise<ActionItem[]> {
  const now = opts.now ?? new Date();
  const conds = [eq(actionItems.userId, userId), or(eq(actionItems.status, 'open'), and(eq(actionItems.status, 'snoozed'), lte(actionItems.snoozeUntil, now)))!];
  if (opts.types?.length) conds.push(inArray(actionItems.type, opts.types));
  return db
    .select()
    .from(actionItems)
    .where(and(...conds))
    .orderBy(desc(actionItems.priority), asc(actionItems.createdAt))
    .limit(opts.limit ?? 200);
}

export async function getAction(db: Db, userId: string, id: string): Promise<ActionItem | null> {
  const [row] = await db.select().from(actionItems).where(and(eq(actionItems.userId, userId), eq(actionItems.id, id)));
  return row ?? null;
}
