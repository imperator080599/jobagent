// Connexion à Gmail par OAuth 2.0 (autorisation de l'utilisateur sur la page de
// Google ; aucun mot de passe n'est jamais demandé ni stocké).
//  - Deux autorisations distinctes : lecture (gmail.readonly) et rédaction
//    (gmail.compose). La seconde n'est demandée que si l'utilisateur la choisit.
//  - Le jeton de rafraîchissement est chiffré au repos ; le jeton d'accès ne vit
//    qu'en mémoire, le temps d'une synchronisation.
//  - Seuls les messages liés à la recherche d'emploi sont lus : la requête envoyée
//    à Gmail est restreinte côté serveur, le reste de la boîte n'est jamais parcouru.
//  - Révocation à tout moment depuis les paramètres (le jeton est révoqué chez Google).
import { createHash } from 'node:crypto';
import type { UserContext } from '../core/context.js';
import { hmacSign, randomToken, safeEqual } from '../core/crypto.js';
import { ConfigError } from '../core/errors.js';
import { deleteSecret, getSecret, setSecret } from '../core/secrets.js';
import { getSetting, setSetting } from '../core/settings.js';
import { htmlToText } from '../search/normalize.js';

export const SCOPE_READ = 'https://www.googleapis.com/auth/gmail.readonly';
export const SCOPE_COMPOSE = 'https://www.googleapis.com/auth/gmail.compose';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export const redirectUri = (ctx: UserContext) => `${ctx.env.appUrl}/api/mail/gmail/callback`;

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export interface AuthStart {
  url: string;
  /** Secret de vérification (PKCE), à conserver dans un cookie HttpOnly jusqu'au retour de Google. */
  verifier: string;
}

/** Prépare la redirection vers la page d'autorisation de Google. `state` est signé : un retour forgé est refusé. */
export async function startAuth(ctx: UserContext, access: 'read' | 'compose'): Promise<AuthStart> {
  const cfg = await getSetting(ctx.db, ctx.userId, 'email.gmail');
  if (!cfg.clientId.trim()) throw new ConfigError("Renseignez d'abord l'identifiant client OAuth de votre projet Google (Paramètres → Messagerie).", 'gmail_client_missing');
  if (!(await getSecret(ctx.db, ctx.env.appSecret, ctx.userId, 'google_client_secret'))) throw new ConfigError('Renseignez le secret client OAuth de votre projet Google (Paramètres → Messagerie).', 'gmail_client_missing');
  const verifier = randomToken(48);
  const payload = b64url(JSON.stringify({ u: ctx.userId, a: access, n: randomToken(8), e: ctx.now().getTime() + 15 * 60_000 }));
  const state = `${payload}.${hmacSign(ctx.env.appSecret, 'gmail-oauth', payload)}`;
  // La lecture est toujours demandée ; la rédaction s'y ajoute seulement si elle est choisie.
  const scopes = access === 'compose' ? [SCOPE_READ, SCOPE_COMPOSE] : [SCOPE_READ];
  const params = new URLSearchParams({
    client_id: cfg.clientId.trim(),
    redirect_uri: redirectUri(ctx),
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: b64url(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
  });
  return { url: `${AUTH_URL}?${params}`, verifier };
}

export function readState(ctx: { env: { appSecret: string }; now: () => Date }, state: string): { userId: string; access: 'read' | 'compose' } | null {
  const [payload, sig] = state.split('.');
  if (!payload || !sig || !safeEqual(sig, hmacSign(ctx.env.appSecret, 'gmail-oauth', payload))) return null;
  try {
    const p = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as { u: string; a: 'read' | 'compose'; e: number };
    if (p.e < ctx.now().getTime()) return null;
    return { userId: p.u, access: p.a === 'compose' ? 'compose' : 'read' };
  } catch {
    return null;
  }
}

async function tokenRequest(ctx: UserContext, body: Record<string, string>): Promise<{ access_token?: string; refresh_token?: string; scope?: string; error?: string; error_description?: string }> {
  const cfg = await getSetting(ctx.db, ctx.userId, 'email.gmail');
  const secret = await getSecret(ctx.db, ctx.env.appSecret, ctx.userId, 'google_client_secret');
  const res = await ctx.fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: cfg.clientId.trim(), client_secret: secret ?? '', ...body }).toString() });
  return (await res.json().catch(() => ({ error: `http_${res.status}` }))) as Awaited<ReturnType<typeof tokenRequest>>;
}

/** Retour de Google : échange du code, enregistrement chiffré du jeton, relevé des autorisations réellement accordées. */
export async function finishAuth(ctx: UserContext, code: string, verifier: string): Promise<{ account: string; canRead: boolean; canCompose: boolean }> {
  const tok = await tokenRequest(ctx, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri(ctx) });
  if (!tok.access_token) throw new Error(`Google a refusé la connexion : ${tok.error_description ?? tok.error ?? 'réponse inattendue'}`);
  const scopes = (tok.scope ?? '').split(/\s+/);
  const canRead = scopes.includes(SCOPE_READ);
  const canCompose = scopes.includes(SCOPE_COMPOSE);
  if (!canRead) throw new Error("L'autorisation de lecture n'a pas été accordée : la connexion n'est pas enregistrée.");
  if (tok.refresh_token) await setSecret(ctx.db, ctx.env.appSecret, ctx.userId, 'gmail_refresh_token', tok.refresh_token);
  else if (!(await getSecret(ctx.db, ctx.env.appSecret, ctx.userId, 'gmail_refresh_token'))) throw new Error("Google n'a pas fourni de jeton durable. Retirez l'accès de JobAgent dans votre compte Google, puis reconnectez-vous.");
  const profile = (await (await ctx.fetch(`${API}/profile`, { headers: { authorization: `Bearer ${tok.access_token}` } })).json().catch(() => ({}))) as { emailAddress?: string };
  const cfg = await getSetting(ctx.db, ctx.userId, 'email.gmail');
  const next = { ...cfg, account: profile.emailAddress ?? cfg.account, canRead, canCompose, connectedAt: ctx.now().toISOString(), allowSend: canCompose ? cfg.allowSend : false };
  await setSetting(ctx.db, ctx.userId, 'email.gmail', next, 'user');
  return { account: next.account, canRead, canCompose };
}

/** Révoque l'accès chez Google et efface le jeton. Les emails déjà rattachés à vos candidatures sont conservés. */
export async function disconnect(ctx: UserContext): Promise<void> {
  const token = await getSecret(ctx.db, ctx.env.appSecret, ctx.userId, 'gmail_refresh_token');
  if (token) {
    try {
      await ctx.fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    } catch (err) {
      ctx.log.warn('gmail_revoke_failed', { error: String(err) });
    }
  }
  await deleteSecret(ctx.db, ctx.userId, 'gmail_refresh_token');
  const cfg = await getSetting(ctx.db, ctx.userId, 'email.gmail');
  await setSetting(ctx.db, ctx.userId, 'email.gmail', { ...cfg, account: '', canRead: false, canCompose: false, connectedAt: '', allowSend: false }, 'user');
}

export interface GmailClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

/** Client authentifié pour la durée d'un traitement. Lève une erreur de configuration si l'accès a été retiré. */
export async function gmailClient(ctx: UserContext): Promise<GmailClient> {
  const refresh = await getSecret(ctx.db, ctx.env.appSecret, ctx.userId, 'gmail_refresh_token');
  if (!refresh) throw new ConfigError("Gmail n'est pas connecté (Paramètres → Messagerie).", 'gmail_not_connected');
  const tok = await tokenRequest(ctx, { grant_type: 'refresh_token', refresh_token: refresh });
  if (!tok.access_token) {
    if (tok.error === 'invalid_grant') {
      // Accès retiré côté Google, ou jeton expiré : on le constate, on n'insiste pas.
      await deleteSecret(ctx.db, ctx.userId, 'gmail_refresh_token');
      const cfg = await getSetting(ctx.db, ctx.userId, 'email.gmail');
      await setSetting(ctx.db, ctx.userId, 'email.gmail', { ...cfg, canRead: false, canCompose: false, allowSend: false }, 'system');
      throw new ConfigError("L'accès à Gmail a expiré ou a été retiré : reconnectez votre compte (Paramètres → Messagerie).", 'gmail_not_connected');
    }
    throw new Error(`Gmail : jeton d'accès refusé (${tok.error ?? 'erreur inconnue'})`);
  }
  const headers = { authorization: `Bearer ${tok.access_token}` };
  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await ctx.fetch(`${API}${path}`, { ...init, headers: { ...headers, ...(init?.body ? { 'content-type': 'application/json' } : {}) } });
    if (!res.ok) throw new Error(`Gmail a répondu ${res.status} pour ${path.split('?')[0]}`);
    return (await res.json()) as T;
  };
  return { get: (p) => call(p), post: (p, body) => call(p, { method: 'POST', body: JSON.stringify(body) }) };
}

// ── Lecture d'un message ──

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}
export interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

export interface ParsedMail {
  gmailId: string;
  threadId: string;
  messageId: string;
  fromAddr: string;
  fromName: string;
  to: string;
  subject: string;
  date: Date | null;
  snippet: string;
  text: string;
  html: string;
}

const decodeB64 = (data?: string) => (data ? Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8') : '');

function collect(part: GmailPart | undefined, out: { text: string; html: string }) {
  if (!part) return;
  if (part.filename) return; // pièce jointe : jamais lue
  if (part.mimeType === 'text/plain' && !out.text) out.text = decodeB64(part.body?.data);
  else if (part.mimeType === 'text/html' && !out.html) out.html = decodeB64(part.body?.data);
  for (const p of part.parts ?? []) collect(p, out);
}

export function parseMessage(m: GmailMessage): ParsedMail {
  const h = (name: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase())?.value ?? '';
  const from = h('From');
  const addr = /<([^>]+)>/.exec(from)?.[1] ?? from.trim();
  const name = from.replace(/<[^>]+>/, '').replace(/^"|"$/g, '').trim().replace(/^"|"$/g, '');
  const body = { text: '', html: '' };
  collect(m.payload, body);
  const text = (body.text || (body.html ? htmlToText(body.html) : '')).replace(/\r/g, '').slice(0, 20_000);
  const date = m.internalDate ? new Date(Number(m.internalDate)) : h('Date') ? new Date(h('Date')) : null;
  return { gmailId: m.id, threadId: m.threadId, messageId: h('Message-ID') || h('Message-Id') || `gmail:${m.id}`, fromAddr: addr.toLowerCase(), fromName: name, to: h('To'), subject: h('Subject'), date: date && !Number.isNaN(date.getTime()) ? date : null, snippet: m.snippet ?? '', text, html: body.html.slice(0, 200_000) };
}

/** Crée un brouillon dans Gmail (jamais d'envoi). Répond dans le fil d'origine quand il est connu. */
export async function createDraft(ctx: UserContext, d: { to: string; subject: string; body: string; threadId?: string; inReplyTo?: string }): Promise<string> {
  const cfg = await getSetting(ctx.db, ctx.userId, 'email.gmail');
  if (!cfg.canCompose) throw new ConfigError("L'autorisation de rédaction n'a pas été accordée à Gmail (Paramètres → Messagerie).", 'gmail_compose_missing');
  const client = await gmailClient(ctx);
  const enc = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
  const lines = [`To: ${d.to}`, `Subject: ${enc(d.subject)}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', ...(d.inReplyTo ? [`In-Reply-To: ${d.inReplyTo}`, `References: ${d.inReplyTo}`] : []), '', Buffer.from(d.body, 'utf8').toString('base64')];
  const res = await client.post<{ id: string }>('/drafts', { message: { raw: b64url(lines.join('\r\n')), ...(d.threadId ? { threadId: d.threadId } : {}) } });
  return res.id;
}
