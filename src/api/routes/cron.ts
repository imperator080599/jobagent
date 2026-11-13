// Déclenchement externe du planificateur (plateformes qui endorment l'application
// ou exécution serverless). Protégé par CRON_SECRET ; sans secret configuré, la route est fermée.
// Sur un serveur ou un conteneur toujours allumé, le planificateur intégré suffit.
import { safeEqual } from '../../core/crypto.js';
import { forbidden } from '../../core/errors.js';
import { schedulerTick } from '../../pipeline/scheduler.js';
import { runWorker } from '../../pipeline/worker.js';
import { type AppDeps, router } from '../http.js';

export function cronRoutes(deps: AppDeps) {
  const r = router();
  const { ctx } = deps;
  r.all('/tick', async (c) => {
    const given = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!ctx.env.cronSecret || !given || !safeEqual(given, ctx.env.cronSecret)) throw forbidden('Appel planifié non autorisé.');
    const tick = await schedulerTick(ctx);
    const work = await runWorker(ctx, { budgetMs: Math.min(240_000, Number(c.req.query('budget')) || 50_000), workerId: 'cron' });
    return c.json({ started: tick.started.length, requeued: tick.requeued, ...work });
  });
  return r;
}
