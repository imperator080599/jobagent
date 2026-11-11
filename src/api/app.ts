// Assemblage de l'API HTTP (Hono). La même application tourne sur un serveur Node
// (local, conteneur) et en fonction serverless (Vercel).
import { Hono } from 'hono';
import { publicUser } from '../auth/service.js';
import { type AppDeps, type AppEnv } from './http.js';
import { csrfGuard, handleError, requireAuth, securityHeaders } from './middleware.js';
import { authRoutes } from './routes/auth.js';
import { settingsRoutes } from './routes/settings.js';

export type RouteInstaller = (app: Hono<AppEnv>, deps: AppDeps) => void;
const publicInstallers: RouteInstaller[] = [];
const privateInstallers: RouteInstaller[] = [];

/** Les modules métier enregistrent leurs routes ici (publiques = sans session, ex. cron signé). */
export function registerRoutes(kind: 'public' | 'private', installer: RouteInstaller) {
  (kind === 'public' ? publicInstallers : privateInstallers).push(installer);
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>().basePath('/api');

  app.use('*', async (c, next) => {
    c.set('ctx', deps.ctx);
    await next();
  });
  app.use('*', securityHeaders);
  app.use('*', csrfGuard);
  app.onError(handleError);
  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Route inconnue.' } }, 404));

  app.get('/health', (c) => c.json({ ok: true, time: deps.ctx.now().toISOString() }));
  app.route('/auth', authRoutes(deps));
  for (const install of publicInstallers) install(app, deps);

  // Tout ce qui suit exige une session ou un jeton d'API valide.
  app.use('*', requireAuth);
  app.get('/me', (c) => c.json({ user: publicUser(c.get('user')) }));
  app.route('/settings', settingsRoutes(deps));
  for (const install of privateInstallers) install(app, deps);

  return app;
}
