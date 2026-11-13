// Outils de test : contexte applicatif complet sur une base Postgres embarquée en
// mémoire (mêmes migrations qu'en production), horloge et réseau injectables.
import { randomBytes } from 'node:crypto';
import type { Hono } from 'hono';
import { openDb, type DbHandle } from '../src/db/client.js';
import { loadEnv, type Env } from '../src/env.js';
import { createLogger } from '../src/core/log.js';
import type { AppContext } from '../src/core/context.js';
import { createApp } from '../src/api/app.js';
import type { AppEnv } from '../src/api/http.js';
import '../src/modules.js';

export interface TestEnv {
  ctx: AppContext;
  handle: DbHandle;
  app: Hono<AppEnv>;
  clock: { now: Date; advance(ms: number): void; set(d: Date | string): void };
  kicks: { count: number };
  close(): Promise<void>;
}

export type FetchMock = (url: string, init?: RequestInit) => Promise<Response> | Response;

export async function makeTestEnv(opts: { env?: Partial<Env>; fetch?: FetchMock } = {}): Promise<TestEnv> {
  const env = loadEnv({ nodeEnv: 'test', isProduction: false, isServerless: false, databaseUrl: '', llmProvider: 'mock', setupToken: '', cronSecret: 'test-cron-secret', logLevel: 'error', ...opts.env });
  // Par défaut : Postgres embarqué en mémoire. Avec TEST_DATABASE_URL, chaque fichier de test reçoit
  // sa propre base sur un vrai serveur Postgres (même pilote qu'en production), supprimée ensuite.
  let handle: DbHandle;
  let dropDatabase: (() => Promise<void>) | null = null;
  if (process.env.TEST_DATABASE_URL) {
    const { default: postgres } = await import('postgres');
    const name = `jobagent_test_${randomBytes(6).toString('hex')}`;
    const admin = () => postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
    const a = admin();
    await a.unsafe(`create database ${name}`);
    await a.end({ timeout: 5 });
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.pathname = `/${name}`;
    handle = await openDb({ databaseUrl: url.toString() });
    dropDatabase = async () => {
      const b = admin();
      await b.unsafe(`drop database if exists ${name} with (force)`);
      await b.end({ timeout: 5 });
    };
  } else handle = await openDb({ pgliteDir: null });
  await handle.migrate();
  const clock = {
    // Part de l'heure réelle (cohérent avec les valeurs par défaut de la base) puis n'avance que sur demande.
    now: new Date(),
    advance(ms: number) {
      this.now = new Date(this.now.getTime() + ms);
    },
    set(d: Date | string) {
      this.now = new Date(d);
    },
  };
  const ctx: AppContext = {
    env,
    db: handle.db,
    log: createLogger('error'),
    now: () => new Date(clock.now),
    fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (!opts.fetch) throw new Error(`Accès réseau inattendu pendant un test : ${url}`);
      return opts.fetch(url, init);
    }) as typeof fetch,
  };
  const kicks = { count: 0 };
  const app = createApp({ ctx, kick: () => void kicks.count++ });
  return {
    ctx,
    handle,
    app,
    clock,
    kicks,
    close: async () => {
      await handle.close();
      await dropDatabase?.();
    },
  };
}

/** Client HTTP de test avec gestion des cookies de session. */
export function client(app: Hono<AppEnv>) {
  let cookie = '';
  const call = async (method: string, path: string, json?: unknown, headers: Record<string, string> = {}) => {
    const h: Record<string, string> = { 'x-jobagent-client': 'web', ...headers };
    // Cookie de session du client, complété le cas échéant par des cookies fournis par le test.
    if (cookie) h.cookie = headers.cookie ? `${cookie}; ${headers.cookie}` : cookie;
    let reqBody: string | FormData | undefined;
    if (json instanceof FormData) reqBody = json;
    else if (json !== undefined) {
      h['content-type'] = 'application/json';
      reqBody = JSON.stringify(json);
    }
    const res = await app.request(path, { method, headers: h, body: reqBody });
    const set = res.headers.get('set-cookie');
    if (set) {
      const m = /ja_session=([^;]*)/.exec(set);
      if (m) cookie = m[1] ? `ja_session=${m[1]}` : '';
    }
    const ct = res.headers.get('content-type') ?? '';
    const data = ct.includes('application/json') ? await res.json() : await res.arrayBuffer();
    return { status: res.status, data: data as any, headers: res.headers };
  };
  return {
    get: (p: string, headers?: Record<string, string>) => call('GET', p, undefined, headers),
    post: (p: string, json?: unknown, headers?: Record<string, string>) => call('POST', p, json ?? {}, headers),
    put: (p: string, json?: unknown, headers?: Record<string, string>) => call('PUT', p, json ?? {}, headers),
    patch: (p: string, json?: unknown, headers?: Record<string, string>) => call('PATCH', p, json ?? {}, headers),
    del: (p: string, headers?: Record<string, string>) => call('DELETE', p, undefined, headers),
    raw: call,
    clearCookies: () => {
      cookie = '';
    },
  };
}

export const TEST_PASSWORD = 'correct-horse-battery-staple';

/** Crée le compte propriétaire et renvoie un client authentifié. */
export async function signedIn(t: TestEnv, email = 'owner@example.test') {
  const api = client(t.app);
  const res = await api.post('/api/auth/setup', { email, password: TEST_PASSWORD, name: 'Camille Test' });
  if (res.status !== 200) throw new Error(`setup failed: ${JSON.stringify(res.data)}`);
  return { api, userId: res.data.user.id as string };
}
