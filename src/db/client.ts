// Connexion à la base. Un seul dialecte (Postgres) partout :
//  - DATABASE_URL défini  -> Postgres managé via postgres.js (production) ;
//  - sinon                -> Postgres embarqué (PGlite) dans ./data/pg (local) ou en mémoire (tests).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export { schema };

export interface DbHandle {
  db: Db;
  kind: 'postgres' | 'pglite';
  migrate(): Promise<void>;
  close(): Promise<void>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(here, '../../drizzle');

export async function openDb(opts: { databaseUrl?: string; pgliteDir?: string | null }): Promise<DbHandle> {
  if (opts.databaseUrl) {
    const { default: postgres } = await import('postgres');
    const { drizzle } = await import('drizzle-orm/postgres-js');
    const { migrate } = await import('drizzle-orm/postgres-js/migrator');
    // prepare:false : compatible avec les poolers en mode transaction (Supabase, Neon).
    const client = postgres(opts.databaseUrl, { prepare: false, max: 5, idle_timeout: 20, connect_timeout: 15, onnotice: () => {} });
    const db = drizzle(client, { schema }) as unknown as Db;
    // Drizzle neutralise les convertisseurs de dates du pilote (il convertit lui-même les colonnes).
    // Une date passée dans un fragment SQL écrit à la main arriverait alors sous une forme que
    // Postgres ne sait pas lire : on rétablit ici une conversion ISO pour les objets Date.
    const serializers = (client as unknown as { options: { serializers: Record<number, (v: unknown) => unknown> } }).options.serializers;
    for (const oid of [1184, 1114, 1082]) serializers[oid] = (v) => (v instanceof Date ? v.toISOString() : v);
    return {
      db,
      kind: 'postgres',
      migrate: async () => {
        // Connexion dédiée et unique pour les migrations (pas de pool concurrent).
        const m = postgres(opts.databaseUrl!, { prepare: false, max: 1, onnotice: () => {} });
        try {
          await migrate(drizzle(m), { migrationsFolder: MIGRATIONS_DIR });
        } finally {
          await m.end({ timeout: 5 });
        }
      },
      close: async () => {
        await client.end({ timeout: 5 });
      },
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  if (opts.pgliteDir) mkdirSync(opts.pgliteDir, { recursive: true });
  const client = opts.pgliteDir ? new PGlite(opts.pgliteDir) : new PGlite();
  await client.waitReady;
  const db = drizzle(client, { schema }) as unknown as Db;
  return {
    db,
    kind: 'pglite',
    migrate: async () => {
      await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_DIR });
    },
    close: async () => {
      await client.close();
    },
  };
}

let singleton: Promise<DbHandle> | null = null;

/** Base de l'application (singleton par processus). */
export function getDbHandle(env: { databaseUrl: string; dataDir: string }): Promise<DbHandle> {
  if (!singleton) {
    singleton = openDb({ databaseUrl: env.databaseUrl, pgliteDir: env.databaseUrl ? null : path.join(env.dataDir, 'pg') });
  }
  return singleton;
}

export function resetDbSingleton() {
  singleton = null;
}
