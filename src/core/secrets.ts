// Secrets de l'utilisateur, chiffrés au repos. La valeur en clair ne quitte jamais
// le serveur : l'API ne renvoie qu'un indice masqué (••••abcd).
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { secrets } from '../db/schema.js';
import { decryptSecret, encryptSecret, secretHint } from './crypto.js';

export const SECRET_KEYS = [
  'anthropic_api_key',
  'imap_password',
  'smtp_password',
  'telegram_bot_token',
  'linkedin_access_token',
  'adzuna_app_key',
  'francetravail_client_secret',
  'jooble_api_key',
  'webhook_secret',
] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];

export async function setSecret(db: Db, appSecret: string, userId: string, key: SecretKey, value: string): Promise<void> {
  const row = { userId, key, ciphertext: encryptSecret(appSecret, value), hint: secretHint(value), updatedAt: new Date() };
  await db
    .insert(secrets)
    .values(row)
    .onConflictDoUpdate({ target: [secrets.userId, secrets.key], set: { ciphertext: row.ciphertext, hint: row.hint, updatedAt: row.updatedAt } });
}

export async function getSecret(db: Db, appSecret: string, userId: string, key: SecretKey): Promise<string | null> {
  const [row] = await db.select().from(secrets).where(and(eq(secrets.userId, userId), eq(secrets.key, key)));
  if (!row) return null;
  return decryptSecret(appSecret, row.ciphertext);
}

export async function deleteSecret(db: Db, userId: string, key: SecretKey): Promise<void> {
  await db.delete(secrets).where(and(eq(secrets.userId, userId), eq(secrets.key, key)));
}

/** Liste des secrets configurés (indices masqués uniquement). */
export async function listSecretHints(db: Db, userId: string): Promise<Record<string, { hint: string; updatedAt: Date }>> {
  const rows = await db.select({ key: secrets.key, hint: secrets.hint, updatedAt: secrets.updatedAt }).from(secrets).where(eq(secrets.userId, userId));
  return Object.fromEntries(rows.map((r) => [r.key, { hint: r.hint, updatedAt: r.updatedAt }]));
}
