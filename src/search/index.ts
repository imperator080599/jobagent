// Enregistrement du module de recherche : tâche de collecte d'une source et
// planification périodique. Chaque source a sa propre fréquence ; le planificateur
// ne fait que mettre en file celles dont l'échéance est atteinte.
import { enqueue } from '../core/queue.js';
import { forUser } from '../core/context.js';
import { getSetting } from '../core/settings.js';
import { registerRecurringJob } from '../pipeline/scheduler.js';
import { registerTaskHandler } from '../pipeline/worker.js';
import { dueSources, pruneRuns, runSource } from './engine.js';

registerTaskHandler('source.run', async (ctx, task) => {
  const p = (task.payload ?? {}) as { sourceId?: string; trigger?: 'schedule' | 'manual' };
  if (!p.sourceId) return { skipped: 'no_source' };
  const res = await runSource(ctx, p.sourceId, { trigger: p.trigger ?? 'schedule' });
  return { status: res.run.status, seen: res.run.itemsSeen, relevant: res.run.itemsRelevant, created: res.created.length, expired: res.run.itemsExpired };
});

registerRecurringJob({
  name: 'search.sources',
  async isDue(ctx, userId, lastRunAt, now) {
    const s = await getSetting(ctx.db, userId, 'schedule.search');
    if (!s.enabled) return false;
    // Vérification toutes les dix minutes ; chaque source garde sa propre échéance.
    return !lastRunAt || now.getTime() - lastRunAt.getTime() >= 10 * 60_000;
  },
  async run(ctx, userId, now) {
    const uctx = forUser(ctx, userId);
    const s = await getSetting(ctx.db, userId, 'schedule.search');
    for (const source of await dueSources(uctx, 30)) {
      const every = Math.max(source.intervalMinutes, s.intervalHours * 60);
      if (source.lastRunAt && now.getTime() - source.lastRunAt.getTime() < every * 60_000) continue;
      await enqueue(ctx.db, { type: 'source.run', userId, payload: { sourceId: source.id, trigger: 'schedule' }, idempotencyKey: `source.run:${source.id}`, priority: 30, runAfter: now, maxAttempts: 2 });
    }
    await pruneRuns(uctx);
  },
});

// ── Annuaire des employeurs : liste de départ, découverte et vérification des sites carrières ──
registerTaskHandler('company.discover', async (ctx, task) => {
  const p = (task.payload ?? {}) as { companyId?: string };
  if (!p.companyId) return { skipped: 'no_company' };
  const { discoverCompany } = await import('./companies.js');
  const co = await discoverCompany(ctx, p.companyId);
  return { discovery: co.discovery, ats: co.ats };
});

registerRecurringJob({
  name: 'search.companies',
  async isDue(ctx, userId, lastRunAt, now) {
    const s = await getSetting(ctx.db, userId, 'search.companies');
    if (!s.autoDiscover) return false;
    return !lastRunAt || now.getTime() - lastRunAt.getTime() >= 6 * 3600_000;
  },
  async run(ctx, userId, now) {
    const uctx = forUser(ctx, userId);
    const { companiesToDiscover, seedTargetCompanies } = await import('./companies.js');
    const s = await getSetting(ctx.db, userId, 'search.companies');
    if (!s.seeded) {
      await seedTargetCompanies(uctx);
      const { setSetting } = await import('../core/settings.js');
      await setSetting(ctx.db, userId, 'search.companies', { ...s, seeded: true }, 'system');
    }
    for (const co of await companiesToDiscover(uctx, s.perRun)) {
      await enqueue(ctx.db, { type: 'company.discover', userId, payload: { companyId: co.id }, idempotencyKey: `company.discover:${co.id}`, priority: 20, runAfter: now, maxAttempts: 2 });
    }
  },
});
