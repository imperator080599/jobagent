// Enregistrement du suivi : synchronisation de la messagerie et contrôle quotidien des relances.
import { forUser } from '../core/context.js';
import { enqueue } from '../core/queue.js';
import { getSecret } from '../core/secrets.js';
import { getSetting } from '../core/settings.js';
import { registerRecurringJob } from '../pipeline/scheduler.js';
import { registerTaskHandler } from '../pipeline/worker.js';
import { checkFollowUps } from './followup.js';
import { syncMail } from './mail.js';

registerTaskHandler('mail.sync', async (ctx) => ({ ...(await syncMail(ctx)) }));
registerTaskHandler('followups.check', async (ctx) => ({ ...(await checkFollowUps(ctx)) }));

registerRecurringJob({
  name: 'mail.sync',
  async isDue(ctx, userId, lastRunAt, now) {
    const s = await getSetting(ctx.db, userId, 'schedule.email');
    const g = await getSetting(ctx.db, userId, 'email.gmail');
    if (!s.enabled || !g.canRead) return false;
    if (lastRunAt && now.getTime() - lastRunAt.getTime() < s.intervalMinutes * 60_000) return false;
    return Boolean(await getSecret(ctx.db, ctx.env.appSecret, userId, 'gmail_refresh_token'));
  },
  async run(ctx, userId, now) {
    await enqueue(ctx.db, { type: 'mail.sync', userId, idempotencyKey: `mail.sync:${userId}`, runAfter: now, priority: 45, maxAttempts: 2 });
  },
});

registerRecurringJob({
  name: 'followups.check',
  async isDue(_ctx, _userId, lastRunAt, now) {
    return !lastRunAt || now.getTime() - lastRunAt.getTime() >= 12 * 3600_000;
  },
  async run(ctx, userId, now) {
    void forUser;
    await enqueue(ctx.db, { type: 'followups.check', userId, idempotencyKey: `followups.check:${userId}`, runAfter: now, priority: 25, maxAttempts: 2 });
  },
});
