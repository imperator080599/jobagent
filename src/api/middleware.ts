import { getCookie } from 'hono/cookie';
import type { MiddlewareHandler } from 'hono';
import { ZodError } from 'zod';
import { HttpError, forbidden, unauthorized } from '../core/errors.js';
import { errorMessage } from '../core/log.js';
import { SESSION_COOKIE, getApiTokenUser, getSessionUser } from '../auth/service.js';
import { forUser } from '../core/context.js';
import type { AppEnv, Ctx } from './http.js';

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cache-Control', 'no-store');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
};

/**
 * Protection CSRF pour les sessions par cookie : toute requête modifiante doit
 * provenir de la même origine et porter un en-tête personnalisé (qu'un site tiers
 * ne peut pas envoyer sans pré-vérification CORS, laquelle n'est jamais accordée).
 */
export const csrfGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const method = c.req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  if (c.req.header('authorization')?.startsWith('Bearer ')) return next();
  if (c.req.path.startsWith('/api/cron/')) return next();
  const origin = c.req.header('origin');
  if (origin) {
    const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? '';
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      /* origine illisible : refus ci-dessous */
    }
    if (originHost !== host) throw forbidden('Origine de la requête refusée.');
  }
  if (c.req.header('x-jobagent-client') !== 'web') throw forbidden('En-tête de sécurité manquant.');
  return next();
};

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ctx = c.get('ctx');
  const bearer = c.req.header('authorization');
  if (bearer?.startsWith('Bearer ')) {
    const found = await getApiTokenUser(ctx.db, bearer.slice(7).trim());
    if (!found) throw unauthorized('Jeton invalide ou révoqué.');
    c.set('user', found.user);
    c.set('uctx', forUser(ctx, found.user.id));
    c.set('authKind', 'token');
    c.set('scopes', found.scopes);
    return next();
  }
  const token = getCookie(c, SESSION_COOKIE);
  const found = token ? await getSessionUser(ctx.db, token) : null;
  if (!found) throw unauthorized();
  c.set('user', found.user);
  c.set('uctx', forUser(ctx, found.user.id));
  c.set('sessionId', found.sessionId);
  c.set('authKind', 'session');
  c.set('scopes', ['*']);
  return next();
};

/** Les jetons d'API n'ont accès qu'aux routes correspondant à leurs portées. */
export function requireScope(scope: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const scopes = c.get('scopes') ?? [];
    if (!scopes.includes('*') && !scopes.includes(scope)) throw forbidden('Portée insuffisante pour ce jeton.');
    return next();
  };
}

/** Réservé aux sessions interactives (jamais aux jetons d'API). */
export const sessionOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('authKind') !== 'session') throw forbidden('Action réservée à une session interactive.');
  return next();
};

export const ownerOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('user').role !== 'owner') throw forbidden('Action réservée au propriétaire.');
  return next();
};

export function handleError(err: unknown, c: Ctx) {
  if (err instanceof HttpError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as 400);
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const where = first?.path?.length ? ` (${first.path.join('.')})` : '';
    return c.json({ error: { code: 'validation', message: `Donnée invalide${where} : ${first?.message ?? ''}`, details: err.issues } }, 400);
  }
  c.get('ctx')?.log.error('unhandled_error', { path: c.req.path, method: c.req.method, error: errorMessage(err), stack: err instanceof Error ? err.stack?.split('\n').slice(0, 6).join(' | ') : undefined });
  return c.json({ error: { code: 'internal', message: 'Erreur interne. Elle a été journalisée.' } }, 500);
}
