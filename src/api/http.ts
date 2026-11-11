// Types et utilitaires communs aux routes HTTP.
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { z } from 'zod';
import type { AppContext, UserContext } from '../core/context.js';
import type { User } from '../auth/service.js';
import { badRequest } from '../core/errors.js';

export type AppEnv = {
  Variables: {
    ctx: AppContext;
    user: User;
    uctx: UserContext;
    sessionId: string;
    authKind: 'session' | 'token';
    scopes: string[];
  };
};

export type Ctx = Context<AppEnv>;

export interface AppDeps {
  ctx: AppContext;
  /** Réveille le traitement de fond (worker local, ou invocation différée en serverless). */
  kick: (c?: Ctx) => void;
}

export function router() {
  return new Hono<AppEnv>();
}

export async function body<T extends z.ZodType>(c: Ctx, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest('Corps de requête JSON invalide.');
  }
  return schema.parse(raw);
}

export function clientIp(c: Ctx): string {
  const xff = c.req.header('x-forwarded-for');
  return (xff?.split(',')[0] ?? c.req.header('x-real-ip') ?? '').trim() || 'local';
}

export function isHttps(c: Ctx): boolean {
  return c.req.header('x-forwarded-proto') === 'https' || new URL(c.req.url).protocol === 'https:';
}
