// Accès réseau sortant des connecteurs. Règles appliquées à toutes les sources :
//  - identification honnête (User-Agent explicite, jamais de navigateur imité) ;
//  - aucune tentative de contournement : un refus (401/403/429, CAPTCHA) est
//    remonté tel quel et la source est marquée « accès restreint » ;
//  - robots.txt respecté pour les pages web (les API publiques documentées
//    ne sont pas des pages et sont appelées dans les limites prévues) ;
//  - adresses internes interdites (une URL fournie par l'utilisateur ou par une
//    offre ne doit jamais permettre d'atteindre le réseau privé du serveur) ;
//  - délai maximal, taille maximale, cadence limitée par hôte.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { AppContext } from '../core/context.js';

export const USER_AGENT = 'JobAgent/1.0 (personal job-search assistant; low request rate)';

export class FetchError extends Error {
  constructor(
    message: string,
    public status: number,
    /** blocked = accès refusé par le site (à ne pas contourner) ; not_found = offre retirée ; network = panne passagère. */
    public kind: 'blocked' | 'not_found' | 'rate_limited' | 'server' | 'network' | 'too_large' | 'forbidden_target' | 'robots',
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}

function isPrivateAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.') || v.startsWith('::ffff:169.254.')) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v)?.[1];
    return mapped ? isPrivateAddress(mapped) : false;
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** Refuse les cibles internes (localhost, réseau privé, service de métadonnées du cloud). */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchError('Adresse invalide.', 0, 'forbidden_target');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new FetchError('Seules les adresses http(s) sont acceptées.', 0, 'forbidden_target');
  if (u.username || u.password) throw new FetchError('Adresse refusée (identifiants intégrés).', 0, 'forbidden_target');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host === 'metadata.google.internal') {
    throw new FetchError('Adresse interne refusée.', 0, 'forbidden_target');
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new FetchError('Adresse interne refusée.', 0, 'forbidden_target');
    return u;
  }
  try {
    const addrs = await lookup(host, { all: true });
    if (addrs.length && addrs.every((a) => isPrivateAddress(a.address))) throw new FetchError('Adresse interne refusée.', 0, 'forbidden_target');
  } catch (err) {
    if (err instanceof FetchError) throw err;
    // Résolution impossible depuis ce réseau (proxy sortant) : la requête échouera d'elle-même si l'hôte n'existe pas.
  }
  return u;
}

// Cadence : au plus une requête toutes les `minIntervalMs` par hôte (par processus).
const lastHit = new Map<string, number>();
async function throttle(host: string, minIntervalMs: number) {
  if (minIntervalMs <= 0) return;
  const now = Date.now();
  const wait = (lastHit.get(host) ?? 0) + minIntervalMs - now;
  lastHit.set(host, Math.max(now, (lastHit.get(host) ?? 0) + minIntervalMs));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

export interface FetchOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  accept?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Délai minimal entre deux requêtes vers le même hôte. */
  minIntervalMs?: number;
  /** URL fournie par un tiers (utilisateur, offre) : contrôle des cibles internes à chaque redirection. */
  untrustedTarget?: boolean;
}

export interface FetchResult {
  status: number;
  url: string;
  text: string;
  contentType: string;
  headers: Headers;
}

const CAPTCHA = /(captcha|cf-chl|challenge-platform|are you a robot|unusual traffic|access denied|px-captcha|datadome|perimeterx|incapsula)/i;

export async function fetchText(ctx: AppContext, url: string, o: FetchOptions = {}): Promise<FetchResult> {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    const target = o.untrustedTarget ? await assertPublicUrl(current) : new URL(current);
    await throttle(target.host, o.minIntervalMs ?? 0);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? 20_000);
    let res: Response;
    try {
      res = await ctx.fetch(target.toString(), {
        method: o.method ?? 'GET',
        headers: { 'user-agent': USER_AGENT, accept: o.accept ?? '*/*', 'accept-language': 'fr-FR,fr;q=0.9,en;q=0.8', ...o.headers },
        body: o.body,
        redirect: 'manual',
        signal: ac.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new FetchError(ac.signal.aborted ? `Délai dépassé (${target.host}).` : `Connexion impossible à ${target.host} : ${(err as Error).message}`, 0, 'network');
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      clearTimeout(timer);
      current = new URL(res.headers.get('location')!, target).toString();
      continue;
    }
    try {
      const max = o.maxBytes ?? 8_000_000;
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > max) throw new FetchError(`Réponse trop volumineuse (${target.host}).`, res.status, 'too_large');
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > max) throw new FetchError(`Réponse trop volumineuse (${target.host}).`, res.status, 'too_large');
      const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      if (res.status === 404 || res.status === 410) throw new FetchError(`Page introuvable (${res.status}).`, res.status, 'not_found');
      if (res.status === 429) {
        const ra = Number(res.headers.get('retry-after') ?? 0);
        throw new FetchError(`Trop de requêtes vers ${target.host} : la source demande de ralentir.`, 429, 'rate_limited', ra > 0 ? ra * 1000 : undefined);
      }
      if (res.status === 401 || res.status === 403 || res.status === 451 || (res.status === 503 && CAPTCHA.test(text.slice(0, 4000)))) {
        throw new FetchError(`${target.host} refuse l'accès automatisé (${res.status}). Cet accès n'est pas contourné.`, res.status, 'blocked');
      }
      if (res.status >= 500) throw new FetchError(`Erreur du serveur ${target.host} (${res.status}).`, res.status, 'server');
      if (res.status >= 400) throw new FetchError(`Requête refusée par ${target.host} (${res.status}).`, res.status, 'blocked');
      return { status: res.status, url: target.toString(), text, contentType: res.headers.get('content-type') ?? '', headers: res.headers };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new FetchError('Trop de redirections.', 0, 'network');
}

export async function fetchJson<T = unknown>(ctx: AppContext, url: string, o: FetchOptions = {}): Promise<T> {
  const res = await fetchText(ctx, url, { accept: 'application/json', ...o });
  try {
    return JSON.parse(res.text) as T;
  } catch {
    throw new FetchError(`Réponse illisible de ${new URL(url).host} (JSON attendu).`, res.status, CAPTCHA.test(res.text.slice(0, 4000)) ? 'blocked' : 'server');
  }
}

// ── robots.txt ──

interface RobotsRules {
  allow: string[];
  disallow: string[];
  fetchedAt: number;
}
const robotsCache = new Map<string, RobotsRules>();

export function parseRobots(text: string, agent = 'jobagent'): { allow: string[]; disallow: string[] } {
  const groups: { agents: string[]; allow: string[]; disallow: string[] }[] = [];
  let cur: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], allow: [], disallow: [] };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (!cur) continue;
      if (key === 'allow' && value) cur.allow.push(value);
      if (key === 'disallow' && value) cur.disallow.push(value);
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && agent.includes(a)));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  return { allow: chosen.flatMap((g) => g.allow), disallow: chosen.flatMap((g) => g.disallow) };
}

function ruleMatches(rule: string, path: string): boolean {
  const anchored = rule.endsWith('$');
  const body = anchored ? rule.slice(0, -1) : rule;
  const re = new RegExp(`^${body.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}${anchored ? '$' : ''}`);
  return re.test(path);
}

export function robotsAllows(rules: { allow: string[]; disallow: string[] }, path: string): boolean {
  let best = { len: -1, allow: true };
  for (const r of rules.disallow) if (ruleMatches(r, path) && r.length > best.len) best = { len: r.length, allow: false };
  for (const r of rules.allow) if (ruleMatches(r, path) && r.length >= best.len) best = { len: r.length, allow: true };
  return best.allow;
}

/** Vrai si robots.txt autorise la lecture de cette page par un programme. Sans robots.txt lisible, la lecture est permise. */
export async function allowedByRobots(ctx: AppContext, url: string): Promise<boolean> {
  const u = new URL(url);
  const key = u.origin;
  let rules = robotsCache.get(key);
  if (!rules || Date.now() - rules.fetchedAt > 3600_000) {
    try {
      const res = await fetchText(ctx, `${u.origin}/robots.txt`, { timeoutMs: 8000, maxBytes: 500_000, untrustedTarget: true });
      rules = { ...parseRobots(/<html/i.test(res.text.slice(0, 500)) ? '' : res.text), fetchedAt: Date.now() };
    } catch {
      rules = { allow: [], disallow: [], fetchedAt: Date.now() };
    }
    robotsCache.set(key, rules);
  }
  return robotsAllows(rules, `${u.pathname}${u.search}`);
}

export function resetHttpCaches() {
  robotsCache.clear();
  lastHit.clear();
}
