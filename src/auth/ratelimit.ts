// Limitation de débit en base (fonctionne aussi en serverless, sans mémoire partagée).
import { lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { rateLimits } from '../db/schema.js';

/** Incrémente le compteur de la fenêtre courante et indique si la limite est dépassée. */
export async function hitRateLimit(db: Db, key: string, windowSeconds: number, max: number, now: Date = new Date()): Promise<{ limited: boolean; count: number }> {
  const windowStart = new Date(Math.floor(now.getTime() / (windowSeconds * 1000)) * windowSeconds * 1000);
  const [row] = await db
    .insert(rateLimits)
    .values({ key, windowStart, count: 1 })
    .onConflictDoUpdate({ target: [rateLimits.key, rateLimits.windowStart], set: { count: sql`${rateLimits.count} + 1` } })
    .returning({ count: rateLimits.count });
  const count = row?.count ?? 1;
  return { limited: count > max, count };
}

/** Lit le compteur de la fenêtre courante sans l'incrémenter. */
export async function isRateLimited(db: Db, key: string, windowSeconds: number, max: number, now: Date = new Date()): Promise<boolean> {
  const windowStart = new Date(Math.floor(now.getTime() / (windowSeconds * 1000)) * windowSeconds * 1000);
  const [row] = await db
    .select({ count: rateLimits.count })
    .from(rateLimits)
    .where(sql`${rateLimits.key} = ${key} and ${rateLimits.windowStart} = ${windowStart}`);
  return (row?.count ?? 0) >= max;
}

export async function purgeRateLimits(db: Db, olderThan: Date): Promise<void> {
  await db.delete(rateLimits).where(lt(rateLimits.windowStart, olderThan));
}
