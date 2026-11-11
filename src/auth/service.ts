// Comptes, sessions et jetons d'API. Les jetons ne sont jamais stockés en clair :
// la base ne contient que leur empreinte SHA-256.
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { apiTokens, sessions, users } from '../db/schema.js';
import { newId } from '../db/ids.js';
import { decryptSecret, encryptSecret, randomToken, sha256 } from '../core/crypto.js';
import { hashPassword, passwordProblems, verifyPassword } from './passwords.js';
import { generateTotpSecret, verifyTotp } from './totp.js';
import { badRequest, conflict } from '../core/errors.js';

export type User = typeof users.$inferSelect;
export type PublicUser = Pick<User, 'id' | 'email' | 'name' | 'role' | 'timezone' | 'locale' | 'totpEnabled' | 'createdAt' | 'lastLoginAt'>;

export const SESSION_COOKIE = 'ja_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export function publicUser(u: User): PublicUser {
  return { id: u.id, email: u.email, name: u.name, role: u.role, timezone: u.timezone, locale: u.locale, totpEnabled: u.totpEnabled, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function countUsers(db: Db): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
  return r?.n ?? 0;
}

export async function createUser(db: Db, input: { email: string; password: string; name?: string; role?: 'owner' | 'user'; timezone?: string }): Promise<User> {
  const email = normalizeEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('Adresse email invalide.');
  const problem = passwordProblems(input.password);
  if (problem) throw badRequest(problem);
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing) throw conflict('Un compte existe déjà avec cette adresse.');
  const [user] = await db
    .insert(users)
    .values({ id: newId('usr'), email, name: input.name?.trim() ?? '', passwordHash: await hashPassword(input.password), role: input.role ?? 'user', timezone: input.timezone ?? 'Europe/Paris' })
    .returning();
  return user!;
}

export type AuthResult = { ok: true; user: User } | { ok: false; reason: 'invalid' | 'totp_required' | 'totp_invalid' | 'disabled' };

export async function authenticate(db: Db, appSecret: string, email: string, password: string, totp?: string): Promise<AuthResult> {
  const [user] = await db.select().from(users).where(eq(users.email, normalizeEmail(email)));
  if (!user) {
    // Coût constant : on calcule quand même une empreinte pour ne pas révéler l'existence du compte.
    await verifyPassword(password, 'scrypt$4096$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    return { ok: false, reason: 'invalid' };
  }
  if (!(await verifyPassword(password, user.passwordHash))) return { ok: false, reason: 'invalid' };
  if (user.disabledAt) return { ok: false, reason: 'disabled' };
  if (user.totpEnabled && user.totpSecretEnc) {
    if (!totp) return { ok: false, reason: 'totp_required' };
    const secret = decryptSecret(appSecret, user.totpSecretEnc);
    if (!verifyTotp(secret, totp)) {
      // Code de secours à usage unique.
      const hashed = sha256(totp.trim().toLowerCase());
      if (!user.recoveryCodes.includes(hashed)) return { ok: false, reason: 'totp_invalid' };
      await db.update(users).set({ recoveryCodes: user.recoveryCodes.filter((c) => c !== hashed) }).where(eq(users.id, user.id));
    }
  }
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  return { ok: true, user };
}

export async function createSession(db: Db, userId: string, meta: { userAgent?: string; ip?: string } = {}): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({ id: newId('ses'), userId, tokenHash: sha256(token), userAgent: (meta.userAgent ?? '').slice(0, 300), ip: (meta.ip ?? '').slice(0, 64), expiresAt });
  return { token, expiresAt };
}

export async function getSessionUser(db: Db, token: string): Promise<{ user: User; sessionId: string } | null> {
  if (!token) return null;
  const now = new Date();
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, now)));
  if (!row || row.user.disabledAt) return null;
  // Expiration glissante, rafraîchie au plus une fois par heure.
  if (now.getTime() - row.session.lastSeenAt.getTime() > 3600_000) {
    await db.update(sessions).set({ lastSeenAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) }).where(eq(sessions.id, row.session.id));
  }
  return { user: row.user, sessionId: row.session.id };
}

export async function revokeSessionByToken(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
}

export async function revokeSession(db: Db, userId: string, sessionId: string): Promise<void> {
  await db.delete(sessions).where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
}

export async function revokeAllSessions(db: Db, userId: string, exceptSessionId?: string): Promise<void> {
  await db.delete(sessions).where(exceptSessionId ? and(eq(sessions.userId, userId), sql`${sessions.id} <> ${exceptSessionId}`) : eq(sessions.userId, userId));
}

export async function listSessions(db: Db, userId: string) {
  return db
    .select({ id: sessions.id, userAgent: sessions.userAgent, ip: sessions.ip, createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt, expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, new Date())));
}

export async function changePassword(db: Db, user: User, current: string, next: string): Promise<void> {
  if (!(await verifyPassword(current, user.passwordHash))) throw badRequest('Mot de passe actuel incorrect.');
  const problem = passwordProblems(next);
  if (problem) throw badRequest(problem);
  await db.update(users).set({ passwordHash: await hashPassword(next) }).where(eq(users.id, user.id));
}

// ── Double authentification ──

export async function beginTotpSetup(db: Db, appSecret: string, user: User): Promise<{ secret: string }> {
  const secret = generateTotpSecret();
  await db.update(users).set({ totpSecretEnc: encryptSecret(appSecret, secret), totpEnabled: false }).where(eq(users.id, user.id));
  return { secret };
}

export async function enableTotp(db: Db, appSecret: string, user: User, code: string): Promise<{ recoveryCodes: string[] }> {
  const [fresh] = await db.select().from(users).where(eq(users.id, user.id));
  if (!fresh?.totpSecretEnc) throw badRequest("Lancez d'abord la configuration de la double authentification.");
  if (!verifyTotp(decryptSecret(appSecret, fresh.totpSecretEnc), code)) throw badRequest('Code incorrect.');
  const recoveryCodes = Array.from({ length: 8 }, () => randomToken(6).toLowerCase());
  await db.update(users).set({ totpEnabled: true, recoveryCodes: recoveryCodes.map((c) => sha256(c)) }).where(eq(users.id, user.id));
  return { recoveryCodes };
}

export async function disableTotp(db: Db, user: User, password: string): Promise<void> {
  if (!(await verifyPassword(password, user.passwordHash))) throw badRequest('Mot de passe incorrect.');
  await db.update(users).set({ totpEnabled: false, totpSecretEnc: null, recoveryCodes: [] }).where(eq(users.id, user.id));
}

// ── Jetons d'API (extension navigateur, worker) ──

export async function createApiToken(db: Db, userId: string, name: string, scopes: string[]): Promise<{ id: string; token: string }> {
  const token = `ja_${randomToken(32)}`;
  const id = newId('tok');
  await db.insert(apiTokens).values({ id, userId, name: name.slice(0, 80), tokenHash: sha256(token), scopes });
  return { id, token };
}

export async function getApiTokenUser(db: Db, token: string): Promise<{ user: User; scopes: string[] } | null> {
  if (!token.startsWith('ja_')) return null;
  const [row] = await db
    .select({ tok: apiTokens, user: users })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(and(eq(apiTokens.tokenHash, sha256(token)), isNull(apiTokens.revokedAt)));
  if (!row || row.user.disabledAt) return null;
  await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.tok.id));
  return { user: row.user, scopes: row.tok.scopes };
}

export async function listApiTokens(db: Db, userId: string) {
  return db
    .select({ id: apiTokens.id, name: apiTokens.name, scopes: apiTokens.scopes, createdAt: apiTokens.createdAt, lastUsedAt: apiTokens.lastUsedAt, revokedAt: apiTokens.revokedAt })
    .from(apiTokens)
    .where(eq(apiTokens.userId, userId));
}

export async function revokeApiToken(db: Db, userId: string, id: string): Promise<void> {
  await db.update(apiTokens).set({ revokedAt: new Date() }).where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId)));
}
