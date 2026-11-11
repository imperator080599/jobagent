// Traitement de fond en mode serveur : un planificateur (tick régulier) et un
// worker qui vide la file de tâches. En serverless, les mêmes fonctions sont
// appelées par /api/cron/tick.
import type { AppContext } from '../core/context.js';
import { errorMessage } from '../core/log.js';
import { runWorker } from './worker.js';
import { schedulerTick } from './scheduler.js';

export interface Background {
  wake(): void;
  stop(): void;
}

export function startBackground(ctx: AppContext, opts: { tickMs?: number } = {}): Background {
  let stopped = false;
  let running = false;
  let again = false;

  const drain = async () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await runWorker(ctx, { budgetMs: 10 * 60_000, workerId: `server-${process.pid}` });
      } while (again && !stopped);
    } catch (err) {
      ctx.log.error('worker_crashed', { error: errorMessage(err) });
    } finally {
      running = false;
    }
  };

  const tick = async () => {
    if (stopped) return;
    try {
      await schedulerTick(ctx);
    } catch (err) {
      ctx.log.error('scheduler_tick_failed', { error: errorMessage(err) });
    }
    void drain();
  };

  const timer = setInterval(tick, opts.tickMs ?? 60_000);
  timer.unref();
  setTimeout(tick, 2_000).unref();

  return {
    wake: () => void drain(),
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
