// Démarrage commun : environnement, base, contexte. Utilisé par le serveur Node,
// la fonction serverless et la ligne de commande.
import { loadEnv } from './env.js';
import { getDbHandle, type DbHandle } from './db/client.js';
import { createLogger } from './core/log.js';
import type { AppContext } from './core/context.js';
import './modules.js';

export interface Runtime {
  ctx: AppContext;
  handle: DbHandle;
}

let runtime: Promise<Runtime> | null = null;

export function getRuntime(opts: { migrate?: boolean } = {}): Promise<Runtime> {
  if (!runtime) {
    runtime = (async () => {
      const env = loadEnv();
      const handle = await getDbHandle(env);
      // Base embarquée : les migrations sont toujours appliquées au démarrage.
      // Postgres managé : appliquées au déploiement (npm run db:migrate) ou sur demande.
      if (opts.migrate || handle.kind === 'pglite') await handle.migrate();
      const ctx: AppContext = {
        env,
        db: handle.db,
        log: createLogger(env.logLevel),
        now: () => new Date(),
        fetch: (...args) => globalThis.fetch(...args),
      };
      return { ctx, handle };
    })();
  }
  return runtime;
}
