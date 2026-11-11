// Serveur Node (local ou conteneur) : API + interface statique + planificateur intégré.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createApp } from './api/app.js';
import { getRuntime } from './runtime.js';
import { startBackground } from './pipeline/background.js';

const { ctx } = await getRuntime({ migrate: true });
const background = startBackground(ctx);
const api = createApp({ ctx, kick: () => background.wake() });

const root = new Hono();
root.route('/', api);

const dist = path.resolve(process.cwd(), 'dist');
if (existsSync(path.join(dist, 'index.html'))) {
  const indexHtml = readFileSync(path.join(dist, 'index.html'), 'utf8');
  root.use('/assets/*', serveStatic({ root: './dist' }));
  root.use('/*', serveStatic({ root: './dist' }));
  // Application monopage : toute route inconnue renvoie l'interface.
  root.get('*', (c) => c.html(indexHtml));
} else {
  root.get('*', (c) => c.text("Interface non construite. Lancez `npm run build` (ou `npm run dev` en développement).", 200));
}

const server = serve({ fetch: root.fetch, port: ctx.env.port }, (info) => {
  ctx.log.info('server_started', { port: info.port, url: ctx.env.appUrl, db: ctx.env.databaseUrl ? 'postgres' : 'pglite', llm: ctx.env.llmProvider });
});

const shutdown = async () => {
  ctx.log.info('server_stopping');
  background.stop();
  server.close();
  setTimeout(() => process.exit(0), 500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
