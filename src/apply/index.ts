// Tâche de fond « application.run » : candidature (envoi automatique, remplissage ou préparation).
import { ConfigError, NeedsHumanError } from '../core/errors.js';
import { registerTaskHandler } from '../pipeline/worker.js';
import { runAutomation } from './automation.js';

registerTaskHandler('application.run', async (ctx, task) => {
  const p = (task.payload ?? {}) as { jobId?: string; trigger?: string; afterVerification?: boolean };
  if (!p.jobId) return { skipped: 'no_job' };
  try {
    const r = await runAutomation(ctx, p.jobId, { trigger: p.trigger ?? 'task', afterVerification: p.afterVerification });
    return { status: r.outcome.status, mode: r.plan.mode, platform: r.plan.platform, attemptId: r.attempt?.id ?? null };
  } catch (err) {
    if (err instanceof ConfigError || err instanceof NeedsHumanError) throw err;
    throw err;
  }
});
