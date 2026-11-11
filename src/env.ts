// Configuration issue de l'environnement. Aucun secret n'a de valeur par défaut
// en production : l'application refuse de démarrer plutôt que de tourner sans.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export interface Env {
  nodeEnv: 'development' | 'production' | 'test';
  isProduction: boolean;
  /** Exécution sans processus persistant (Vercel) : le travail de fond est piloté par cron. */
  isServerless: boolean;
  databaseUrl: string;
  dataDir: string;
  appSecret: string;
  appUrl: string;
  port: number;
  setupToken: string;
  cronSecret: string;
  llmProvider: 'anthropic' | 'mock';
  anthropicApiKey: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

let cached: Env | null = null;

function loadDotEnv(file: string) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    const key = m[1]!;
    let value = m[2] ?? '';
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function loadEnv(overrides: Partial<Env> = {}): Env {
  if (cached && Object.keys(overrides).length === 0) return cached;
  loadDotEnv(path.resolve(process.cwd(), '.env'));
  const e = process.env;
  const nodeEnv = (e.NODE_ENV === 'production' ? 'production' : e.NODE_ENV === 'test' || e.VITEST ? 'test' : 'development') as Env['nodeEnv'];
  const isServerless = Boolean(e.VERCEL);
  const isProduction = nodeEnv === 'production' || isServerless;
  const dataDir = path.resolve(process.cwd(), e.DATA_DIR || './data');

  let appSecret = e.APP_SECRET ?? '';
  if (!appSecret) {
    if (isProduction) {
      throw new Error('APP_SECRET est obligatoire en production (openssl rand -base64 48).');
    }
    if (nodeEnv === 'test') {
      appSecret = 'test-secret-test-secret-test-secret-test-secret';
    } else {
      // Développement local : secret généré une fois, conservé hors du dépôt.
      const f = path.join(dataDir, '.app-secret');
      if (existsSync(f)) appSecret = readFileSync(f, 'utf8').trim();
      else {
        mkdirSync(dataDir, { recursive: true });
        appSecret = randomBytes(48).toString('base64');
        writeFileSync(f, appSecret, { mode: 0o600 });
      }
    }
  }
  if (appSecret.length < 32) throw new Error('APP_SECRET doit contenir au moins 32 caractères.');
  if (isProduction && !e.DATABASE_URL) {
    throw new Error('DATABASE_URL est obligatoire en production.');
  }

  const env: Env = {
    nodeEnv,
    isProduction,
    isServerless,
    databaseUrl: e.DATABASE_URL ?? '',
    dataDir,
    appSecret,
    appUrl: (e.APP_URL || (e.VERCEL_PROJECT_PRODUCTION_URL ? `https://${e.VERCEL_PROJECT_PRODUCTION_URL}` : `http://localhost:${e.PORT || 4000}`)).replace(/\/$/, ''),
    port: Number(e.PORT || 4000),
    setupToken: e.SETUP_TOKEN ?? '',
    cronSecret: e.CRON_SECRET ?? '',
    llmProvider: e.LLM_PROVIDER === 'mock' ? 'mock' : 'anthropic',
    anthropicApiKey: e.ANTHROPIC_API_KEY ?? '',
    logLevel: (['debug', 'info', 'warn', 'error'].includes(e.LOG_LEVEL ?? '') ? e.LOG_LEVEL : nodeEnv === 'test' ? 'error' : 'info') as Env['logLevel'],
    ...overrides,
  };
  if (Object.keys(overrides).length === 0) cached = env;
  return env;
}

export function resetEnvCache() {
  cached = null;
}
