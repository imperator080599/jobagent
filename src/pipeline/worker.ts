// Worker : prend les tâches dues une à une et les confie au gestionnaire de leur
// type. Chaque gestionnaire est idempotent : rejouer une tâche ne crée aucun doublon.
import { ConfigError, NeedsHumanError } from '../core/errors.js';
import type { AppContext, UserContext } from '../core/context.js';
import { forUser } from '../core/context.js';
import { errorMessage } from '../core/log.js';
import { logActivity } from '../core/activity.js';
import { type Task, blockTask, claimNext, completeTask, failTask } from '../core/queue.js';

export type TaskHandler = (ctx: UserContext, task: Task) => Promise<Record<string, unknown> | void>;

const handlers = new Map<string, TaskHandler>();

export function registerTaskHandler(type: string, handler: TaskHandler) {
  handlers.set(type, handler);
}

export function hasTaskHandler(type: string): boolean {
  return handlers.has(type);
}

export interface WorkerResult {
  processed: number;
  failed: number;
  blocked: number;
  remaining: boolean;
}

export async function runTask(ctx: AppContext, task: Task): Promise<'done' | 'retry' | 'failed' | 'blocked'> {
  const handler = handlers.get(task.type);
  const log = ctx.log.child({ task: task.id, type: task.type });
  if (!handler) {
    await failTask(ctx.db, task, `Aucun gestionnaire pour le type « ${task.type} »`, { retry: false });
    return 'failed';
  }
  try {
    const result = await handler(forUser(ctx, task.userId ?? ''), task);
    await completeTask(ctx.db, task.id, result ?? undefined);
    return 'done';
  } catch (err) {
    if (err instanceof NeedsHumanError || err instanceof ConfigError) {
      // Rien à réessayer tant que l'utilisateur n'est pas intervenu.
      // Le motif est préfixé pour pouvoir relancer précisément les tâches concernées une fois le problème levé.
      const tag = err instanceof ConfigError ? err.what : err.reason;
      await blockTask(ctx.db, task.id, `[${tag}] ${err.message}`);
      log.info('task_blocked', { reason: err.message });
      return 'blocked';
    }
    const message = errorMessage(err);
    const outcome = await failTask(ctx.db, task, message);
    log.warn('task_failed', { attempt: task.attempts, outcome, error: message });
    if (outcome === 'failed') {
      await logActivity(ctx.db, {
        userId: task.userId,
        actor: 'system',
        level: 'error',
        action: 'task.failed',
        entityType: 'task',
        entityId: task.id,
        summary: `Échec définitif de la tâche ${task.type} après ${task.attempts} essais`,
        data: { error: message, payload: task.payload },
      });
    }
    return outcome;
  }
}

/** Vide la file jusqu'à épuisement ou jusqu'à la fin du budget de temps. */
export async function runWorker(ctx: AppContext, opts: { budgetMs: number; workerId: string; types?: string[]; excludeTypes?: string[]; maxTasks?: number }): Promise<WorkerResult> {
  const deadline = Date.now() + opts.budgetMs;
  const res: WorkerResult = { processed: 0, failed: 0, blocked: 0, remaining: false };
  while (Date.now() < deadline && (opts.maxTasks === undefined || res.processed < opts.maxTasks)) {
    const task = await claimNext(ctx.db, { workerId: opts.workerId, types: opts.types, excludeTypes: opts.excludeTypes, now: ctx.now() });
    if (!task) return res;
    const outcome = await runTask(ctx, task);
    res.processed++;
    if (outcome === 'failed') res.failed++;
    if (outcome === 'blocked') res.blocked++;
  }
  res.remaining = true;
  return res;
}
