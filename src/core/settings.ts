import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { settings } from '../db/schema.js';
import { SETTINGS, SETTING_KEYS, type SettingKey, type SettingValue } from '../shared/settings.js';
import { logActivity } from './activity.js';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Fusion profonde : une valeur stockée partielle hérite des valeurs par défaut (compatibilité ascendante). */
function mergeDefaults<T>(def: T, stored: unknown): T {
  if (isPlainObject(def) && isPlainObject(stored)) {
    const out: Record<string, unknown> = { ...def };
    for (const [k, v] of Object.entries(stored)) out[k] = k in def ? mergeDefaults((def as Record<string, unknown>)[k], v) : v;
    return out as T;
  }
  return (stored === undefined ? def : stored) as T;
}

export async function getSetting<K extends SettingKey>(db: Db, userId: string, key: K): Promise<SettingValue<K>> {
  const [row] = await db.select().from(settings).where(and(eq(settings.userId, userId), eq(settings.key, key)));
  const def = SETTINGS[key].default as SettingValue<K>;
  if (!row) return structuredClone(def);
  const merged = mergeDefaults(def, row.value);
  const parsed = SETTINGS[key].schema.safeParse(merged);
  return (parsed.success ? parsed.data : structuredClone(def)) as SettingValue<K>;
}

export async function getAllSettings(db: Db, userId: string): Promise<{ [K in SettingKey]: SettingValue<K> }> {
  const rows = await db.select().from(settings).where(eq(settings.userId, userId));
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const out: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    const def = SETTINGS[key].default;
    const merged = stored.has(key) ? mergeDefaults(def, stored.get(key)) : structuredClone(def);
    const parsed = SETTINGS[key].schema.safeParse(merged);
    out[key] = parsed.success ? parsed.data : structuredClone(def);
  }
  return out as { [K in SettingKey]: SettingValue<K> };
}

/** Valide puis enregistre un paramètre ; chaque modification est tracée dans le journal. */
export async function setSetting<K extends SettingKey>(db: Db, userId: string, key: K, value: unknown, actor = 'user'): Promise<SettingValue<K>> {
  const def = SETTINGS[key].default;
  const parsed = SETTINGS[key].schema.parse(mergeDefaults(def, value));
  const before = await getSetting(db, userId, key);
  await db
    .insert(settings)
    .values({ userId, key, value: parsed, updatedAt: new Date() })
    .onConflictDoUpdate({ target: [settings.userId, settings.key], set: { value: parsed, updatedAt: new Date() } });
  await logActivity(db, { userId, actor, action: 'setting.updated', entityType: 'setting', entityId: key, summary: `Paramètre « ${key} » modifié`, data: { before, after: parsed } });
  return parsed as SettingValue<K>;
}
