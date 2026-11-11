import { and, desc, eq, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { activityLog } from '../db/schema.js';
import { newId } from '../db/ids.js';

export interface ActivityInput {
  userId: string | null;
  actor: string; // 'user' | 'system' | 'agent:<nom>'
  action: string;
  summary?: string;
  entityType?: string;
  entityId?: string;
  level?: 'info' | 'warn' | 'error';
  data?: Record<string, unknown>;
}

/** Écrit une ligne du journal d'activité permanent. Ne lève jamais : un journal en panne ne doit pas casser une opération métier. */
export async function logActivity(db: Db, a: ActivityInput): Promise<void> {
  try {
    await db.insert(activityLog).values({
      id: newId('act'),
      userId: a.userId,
      actor: a.actor,
      action: a.action,
      summary: a.summary ?? '',
      entityType: a.entityType ?? '',
      entityId: a.entityId ?? '',
      level: a.level ?? 'info',
      data: a.data,
    });
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'activity_log_failed', action: a.action, error: String(err) }));
  }
}

export async function listActivity(db: Db, userId: string, opts: { limit?: number; before?: Date; entityType?: string; entityId?: string } = {}) {
  const conds = [eq(activityLog.userId, userId)];
  if (opts.before) conds.push(lt(activityLog.at, opts.before));
  if (opts.entityType) conds.push(eq(activityLog.entityType, opts.entityType));
  if (opts.entityId) conds.push(eq(activityLog.entityId, opts.entityId));
  return db
    .select()
    .from(activityLog)
    .where(and(...conds))
    .orderBy(desc(activityLog.at))
    .limit(Math.min(opts.limit ?? 100, 500));
}
