// Contexte applicatif : dépendances partagées, injectables dans les tests
// (horloge, accès réseau, base, journal). Aucun module ne lit de variable globale.
import type { Env } from '../env.js';
import type { Db } from '../db/client.js';
import type { Logger } from './log.js';

export interface AppContext {
  env: Env;
  db: Db;
  log: Logger;
  /** Horloge injectable (tests déterministes). */
  now: () => Date;
  /** Accès HTTP sortant injectable (connecteurs testés sur des réponses enregistrées). */
  fetch: typeof fetch;
}

export interface UserContext extends AppContext {
  userId: string;
}

export function forUser(ctx: AppContext, userId: string): UserContext {
  return { ...ctx, userId };
}
