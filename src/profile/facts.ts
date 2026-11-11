// Référentiel personnel. Règles :
//  - une seule valeur validée par clé ; l'ancienne est conservée (statut « superseded ») ;
//  - une valeur validée par l'utilisateur n'est jamais écrasée par une source
//    automatique (CV, LinkedIn) : en cas de contradiction, on propose et on demande ;
//  - chaque valeur porte sa source.
import { and, desc, eq, inArray, like } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { profileFacts } from '../db/schema.js';
import { newId } from '../db/ids.js';
import { logActivity } from '../core/activity.js';
import { raiseAction, resolveAction } from '../core/inbox.js';
import { FACT_BY_KEY, FACT_CATALOG, type SkillFact, skillFactKey } from '../shared/facts.js';

export type Fact = typeof profileFacts.$inferSelect;
export type FactSource = Fact['source'];

function categoryOf(key: string): string {
  if (key.startsWith('skill:')) return 'skills';
  return FACT_BY_KEY.get(key)?.category ?? 'other';
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
}

function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase().replace(/\s+/g, ' ') : JSON.stringify(v));
  return norm(a) === norm(b);
}

export async function getFact(db: Db, userId: string, key: string): Promise<Fact | null> {
  const [row] = await db.select().from(profileFacts).where(and(eq(profileFacts.userId, userId), eq(profileFacts.key, key), eq(profileFacts.status, 'validated')));
  return row ?? null;
}

export async function getFactValue<T = unknown>(db: Db, userId: string, key: string): Promise<T | null> {
  return ((await getFact(db, userId, key))?.value as T) ?? null;
}

export async function listFacts(db: Db, userId: string, opts: { status?: Fact['status'][]; category?: string } = {}): Promise<Fact[]> {
  const conds = [eq(profileFacts.userId, userId), inArray(profileFacts.status, opts.status ?? ['validated', 'proposed'])];
  if (opts.category) conds.push(eq(profileFacts.category, opts.category));
  return db.select().from(profileFacts).where(and(...conds)).orderBy(desc(profileFacts.updatedAt));
}

/** Tous les faits validés sous forme de dictionnaire clé → valeur. */
export async function factsMap(db: Db, userId: string): Promise<Map<string, Fact>> {
  const rows = await listFacts(db, userId, { status: ['validated'] });
  return new Map(rows.map((r) => [r.key, r]));
}

export interface SetFactInput {
  key: string;
  value: unknown;
  source: FactSource;
  sourceRef?: string;
  label?: string;
  actor?: string;
}

export type SetFactResult = { status: 'validated' | 'unchanged' | 'conflict' | 'cleared'; fact?: Fact };

/**
 * Enregistre une information.
 *  - Source « user » : fait autorité, remplace la valeur précédente (conservée dans l'historique).
 *  - Source automatique : valide si la clé est libre ou déjà issue d'une source automatique ;
 *    si elle contredit une valeur validée par l'utilisateur → proposition + demande d'arbitrage.
 */
export async function setFact(db: Db, userId: string, input: SetFactInput): Promise<SetFactResult> {
  const def = FACT_BY_KEY.get(input.key);
  const existing = await getFact(db, userId, input.key);
  const now = new Date();

  if (isEmpty(input.value)) {
    if (existing && input.source === 'user') {
      await db.update(profileFacts).set({ status: 'superseded', updatedAt: now }).where(eq(profileFacts.id, existing.id));
      await logActivity(db, { userId, actor: input.actor ?? 'user', action: 'fact.cleared', entityType: 'fact', entityId: input.key, summary: `Information effacée : ${def?.label ?? input.key}` });
      return { status: 'cleared' };
    }
    return { status: 'unchanged' };
  }
  if (existing && sameValue(existing.value, input.value)) return { status: 'unchanged', fact: existing };

  const row = {
    id: newId('fact'),
    userId,
    category: categoryOf(input.key),
    key: input.key,
    label: input.label ?? def?.label ?? input.key,
    value: input.value,
    source: input.source,
    sourceRef: input.sourceRef ?? '',
    sensitive: def?.sensitive ?? false,
    updatedAt: now,
  };

  if (existing && existing.source === 'user' && input.source !== 'user') {
    // Contradiction avec une information validée par l'utilisateur : jamais d'arbitrage automatique.
    await db.delete(profileFacts).where(and(eq(profileFacts.userId, userId), eq(profileFacts.key, input.key), eq(profileFacts.status, 'proposed')));
    const [proposed] = await db.insert(profileFacts).values({ ...row, status: 'proposed' }).returning();
    await raiseAction(db, {
      userId,
      type: 'fact.conflict',
      title: `Information contradictoire : ${row.label}`,
      body: { key: input.key, label: row.label, current: existing.value, currentSource: existing.source, proposed: input.value, proposedSource: input.source, factId: proposed!.id },
      priority: 60,
      dedupKey: `fact.conflict:${input.key}:${JSON.stringify(input.value).slice(0, 80)}`,
    });
    return { status: 'conflict', fact: proposed };
  }

  const inserted = await db.transaction(async (tx) => {
    if (existing) await tx.update(profileFacts).set({ status: 'superseded', updatedAt: now }).where(eq(profileFacts.id, existing.id));
    const [fact] = await tx.insert(profileFacts).values({ ...row, status: 'validated', validatedAt: now }).returning();
    return fact!;
  });
  await logActivity(db, {
    userId,
    actor: input.actor ?? (input.source === 'user' ? 'user' : 'system'),
    action: 'fact.set',
    entityType: 'fact',
    entityId: input.key,
    summary: `Information ${existing ? 'mise à jour' : 'enregistrée'} : ${row.label}`,
    data: def?.sensitive ? { source: input.source } : { source: input.source, before: existing?.value ?? null, after: input.value },
  });
  return { status: 'validated', fact: inserted };
}

/** Arbitrage d'une proposition contradictoire par l'utilisateur. */
export async function resolveProposedFact(db: Db, userId: string, factId: string, accept: boolean): Promise<void> {
  const [proposed] = await db.select().from(profileFacts).where(and(eq(profileFacts.id, factId), eq(profileFacts.userId, userId), eq(profileFacts.status, 'proposed')));
  if (!proposed) return;
  if (accept) {
    await db.update(profileFacts).set({ status: 'rejected', updatedAt: new Date() }).where(eq(profileFacts.id, factId));
    await setFact(db, userId, { key: proposed.key, value: proposed.value, source: 'user', sourceRef: `accepted:${proposed.source}`, label: proposed.label });
  } else {
    await db.update(profileFacts).set({ status: 'rejected', updatedAt: new Date() }).where(eq(profileFacts.id, factId));
  }
  await resolveAction(db, userId, { dedupKey: `fact.conflict:${proposed.key}:${JSON.stringify(proposed.value).slice(0, 80)}` }, { accepted: accept });
}

/** Historique complet d'une information (valeurs successives et sources). */
export async function factHistory(db: Db, userId: string, key: string): Promise<Fact[]> {
  return db.select().from(profileFacts).where(and(eq(profileFacts.userId, userId), eq(profileFacts.key, key))).orderBy(desc(profileFacts.createdAt));
}

// ── Compétences précisées par l'utilisateur ──

export async function setSkillFact(db: Db, userId: string, skill: SkillFact, sourceRef = ''): Promise<void> {
  await setFact(db, userId, { key: skillFactKey(skill.name), value: skill, source: 'user', sourceRef, label: skill.name });
}

export async function listSkillFacts(db: Db, userId: string): Promise<SkillFact[]> {
  const rows = await db.select().from(profileFacts).where(and(eq(profileFacts.userId, userId), eq(profileFacts.status, 'validated'), like(profileFacts.key, 'skill:%')));
  return rows.map((r) => r.value as SkillFact);
}

/** Informations importantes encore absentes (pour l'accueil et le centre de validation). */
export async function missingImportantFacts(db: Db, userId: string): Promise<{ key: string; label: string }[]> {
  const have = await factsMap(db, userId);
  return FACT_CATALOG.filter((f) => f.important && !have.has(f.key)).map((f) => ({ key: f.key, label: f.label }));
}
