// Notifications : immédiates pour ce qui presse (entretien, offre, demande d'un
// recruteur, source en panne), résumé quotidien pour le reste. Chaque notification
// porte une clé d'unicité par canal : elle n'est jamais envoyée deux fois.
import { and, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import type { UserContext } from '../core/context.js';
import { forUser } from '../core/context.js';
import { hmacSign } from '../core/crypto.js';
import { enqueue } from '../core/queue.js';
import { getSecret } from '../core/secrets.js';
import { getSetting } from '../core/settings.js';
import { newId } from '../db/ids.js';
import { actionItems, applications, interviews, jobs, notifications, users } from '../db/schema.js';
import { llmSpend } from '../llm/index.js';
import { registerRecurringJob } from '../pipeline/scheduler.js';
import { registerTaskHandler } from '../pipeline/worker.js';
import { assertPublicUrl } from '../search/http.js';

export interface Notice {
  kind: string;
  title: string;
  body: string;
  /** Chemin dans l'application (ex. /validation). */
  link?: string;
  dedupKey: string;
}

type Channel = 'ntfy' | 'telegram' | 'webhook';

async function deliver(ctx: UserContext, channel: Channel, n: Notice): Promise<void> {
  const cfg = await getSetting(ctx.db, ctx.userId, 'notifications.channels');
  const url = n.link ? `${ctx.env.appUrl}${n.link}` : ctx.env.appUrl;
  if (channel === 'ntfy') {
    const server = (await assertPublicUrl(cfg.ntfy.server || 'https://ntfy.sh')).origin;
    const res = await ctx.fetch(server, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topic: cfg.ntfy.topic, title: n.title, message: n.body, click: url, tags: [n.kind] }) });
    if (!res.ok) throw new Error(`ntfy a répondu ${res.status}`);
  } else if (channel === 'telegram') {
    const token = await getSecret(ctx.db, ctx.env.appSecret, ctx.userId, 'telegram_bot_token');
    if (!token) throw new Error('Jeton du bot Telegram manquant.');
    const res = await ctx.fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: cfg.telegram.chatId, text: `${n.title}\n\n${n.body}\n\n${url}`, disable_web_page_preview: true }) });
    if (!res.ok) throw new Error(`Telegram a répondu ${res.status}`);
  } else {
    const target = await assertPublicUrl(cfg.webhook.url);
    const payload = JSON.stringify({ kind: n.kind, title: n.title, body: n.body, url, at: ctx.now().toISOString() });
    const secret = await getSecret(ctx.db, ctx.env.appSecret, ctx.userId, 'webhook_secret');
    const res = await ctx.fetch(target.toString(), { method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { 'x-jobagent-signature': hmacSign(secret, 'webhook', payload) } : {}) }, body: payload });
    if (!res.ok) throw new Error(`Le webhook a répondu ${res.status}`);
  }
}

export async function enabledChannels(ctx: UserContext): Promise<Channel[]> {
  const cfg = await getSetting(ctx.db, ctx.userId, 'notifications.channels');
  const out: Channel[] = [];
  if (cfg.ntfy.enabled && cfg.ntfy.topic.trim()) out.push('ntfy');
  if (cfg.telegram.enabled && cfg.telegram.chatId.trim()) out.push('telegram');
  if (cfg.webhook.enabled && cfg.webhook.url.trim()) out.push('webhook');
  return out;
}

/** Envoie une notification sur les canaux actifs. Renvoie le nombre d'envois réussis. */
export async function notify(ctx: UserContext, n: Notice, opts: { force?: boolean } = {}): Promise<{ sent: number; failed: string[] }> {
  let sent = 0;
  const failed: string[] = [];
  for (const channel of await enabledChannels(ctx)) {
    if (!opts.force) {
      const reserved = await ctx.db.insert(notifications).values({ id: newId('ntf'), userId: ctx.userId, channel, kind: n.kind, dedupKey: n.dedupKey, title: n.title, body: n.body.slice(0, 2000), status: 'sent' }).onConflictDoNothing().returning({ id: notifications.id });
      if (!reserved.length) continue; // déjà envoyée sur ce canal
      try {
        await deliver(ctx, channel, n);
        sent++;
      } catch (err) {
        failed.push(`${channel} : ${(err as Error).message}`);
        await ctx.db.update(notifications).set({ status: 'failed', error: String((err as Error).message).slice(0, 500) }).where(eq(notifications.id, reserved[0]!.id));
      }
    } else {
      try {
        await deliver(ctx, channel, n);
        sent++;
      } catch (err) {
        failed.push(`${channel} : ${(err as Error).message}`);
      }
    }
  }
  return { sent, failed };
}

/** Événements à signaler sans attendre, d'après les demandes ouvertes du centre de validation. */
const URGENT: Record<string, (title: string) => string> = {
  'interview.detected': (t) => (/^Proposition d'embauche/.test(t) ? 'offer' : 'interview'),
  'email.review': (t) => (/attend une réponse/.test(t) ? 'recruiter_request' : ''),
  'system.alert': (t) => (/^Source en panne/.test(t) ? 'source_down' : /Budget IA/.test(t) ? 'budget_reached' : ''),
};

export async function notifyUrgent(ctx: UserContext): Promise<number> {
  const wanted = new Set(await getSetting(ctx.db, ctx.userId, 'notifications.immediate'));
  if (!(await enabledChannels(ctx)).length) return 0;
  const since = new Date(ctx.now().getTime() - 2 * 86400_000);
  const items = await ctx.db.select().from(actionItems).where(and(eq(actionItems.userId, ctx.userId), eq(actionItems.status, 'open'), inArray(actionItems.type, Object.keys(URGENT)), gte(actionItems.createdAt, since)));
  let n = 0;
  for (const item of items) {
    const kind = URGENT[item.type]!(item.title);
    if (!kind || !wanted.has(kind)) continue;
    const res = await notify(ctx, { kind, title: item.title, body: String((item.body as { text?: string }).text ?? ''), link: '/validation', dedupKey: `action:${item.id}` });
    n += res.sent;
  }
  return n;
}

export interface Digest {
  title: string;
  body: string;
  empty: boolean;
}

/** Résumé quotidien : ce qui est arrivé depuis hier et ce qui attend une décision. */
export async function buildDigest(ctx: UserContext): Promise<Digest> {
  const now = ctx.now();
  const dayAgo = new Date(now.getTime() - 86400_000);
  const soon = new Date(now.getTime() + 7 * 86400_000);
  const count = async (where: ReturnType<typeof and>) => (await ctx.db.select({ n: sql<number>`count(*)::int` }).from(jobs).where(where))[0]?.n ?? 0;
  const [fresh, toDecide, ready, [inbox], top, sent, due, upcoming, deadlines, spend] = await Promise.all([
    count(and(eq(jobs.userId, ctx.userId), gte(jobs.firstSeenAt, dayAgo), sql`${jobs.stage} not in ('filtered', 'expired')`)),
    count(and(eq(jobs.userId, ctx.userId), eq(jobs.stage, 'awaiting_feedback'))),
    count(and(eq(jobs.userId, ctx.userId), eq(jobs.stage, 'ready_to_apply'))),
    ctx.db.select({ n: sql<number>`count(*)::int` }).from(actionItems).where(and(eq(actionItems.userId, ctx.userId), eq(actionItems.status, 'open'))),
    ctx.db.select({ title: jobs.title, companyName: jobs.companyName, atsScore: jobs.atsScore, priorityScore: jobs.priorityScore }).from(jobs).where(and(eq(jobs.userId, ctx.userId), eq(jobs.stage, 'awaiting_feedback'))).orderBy(sql`${jobs.priorityScore} desc nulls last`).limit(3),
    ctx.db.select({ n: sql<number>`count(*)::int` }).from(applications).where(and(eq(applications.userId, ctx.userId), gte(applications.submittedAt, dayAgo))),
    ctx.db.select({ n: sql<number>`count(*)::int` }).from(applications).innerJoin(jobs, eq(jobs.id, applications.jobId)).where(and(eq(applications.userId, ctx.userId), eq(jobs.stage, 'follow_up_needed'))),
    ctx.db.select({ companyName: jobs.companyName, scheduledAt: interviews.scheduledAt }).from(interviews).innerJoin(jobs, eq(jobs.id, interviews.jobId)).where(and(eq(interviews.userId, ctx.userId), inArray(interviews.status, ['to_schedule', 'scheduled']))).orderBy(interviews.scheduledAt).limit(5),
    ctx.db.select({ companyName: jobs.companyName, deadlineAt: jobs.deadlineAt }).from(jobs).where(and(eq(jobs.userId, ctx.userId), isNotNull(jobs.deadlineAt), gte(jobs.deadlineAt, now), lte(jobs.deadlineAt, soon), inArray(jobs.stage, ['awaiting_feedback', 'cv_in_progress', 'letter_in_progress', 'ready_to_apply']))).orderBy(jobs.deadlineAt).limit(5),
    llmSpend(ctx),
  ]);
  const lines: string[] = [];
  if (fresh) lines.push(`${fresh} nouvelle(s) offre(s) retenue(s) depuis hier.`);
  if (toDecide) lines.push(`${toDecide} offre(s) attendent votre avis${top.length ? ` : ${top.map((t) => `${t.companyName} — ${t.title}${t.atsScore != null ? ` (${t.atsScore}/20)` : ''}`).join(' ; ')}` : ''}.`);
  if (ready) lines.push(`${ready} candidature(s) prête(s) à partir.`);
  if (sent[0]?.n) lines.push(`${sent[0].n} candidature(s) envoyée(s) depuis hier.`);
  if (due[0]?.n) lines.push(`${due[0].n} relance(s) à envisager.`);
  if (upcoming.length) lines.push(`Entretiens : ${upcoming.map((i) => `${i.companyName}${i.scheduledAt ? ` le ${i.scheduledAt.toISOString().slice(0, 10)}` : ' (date à fixer)'}`).join(' ; ')}.`);
  if (deadlines.length) lines.push(`Dates limites cette semaine : ${deadlines.map((d) => `${d.companyName} (${d.deadlineAt!.toISOString().slice(0, 10)})`).join(' ; ')}.`);
  const empty = lines.length === 0;
  if (empty) lines.push('Rien de nouveau depuis hier. La recherche continue.');
  lines.push(`Budget IA du mois : ${spend.monthUsd.toFixed(2)} $.`);
  return { title: inbox?.n ? `JobAgent — ${inbox.n} action(s) à valider` : 'JobAgent — résumé du jour', body: lines.join('\n'), empty };
}

/** Heure locale de l'utilisateur (0-23) et date locale, d'après son fuseau. */
export function localClock(now: Date, timeZone: string): { hour: number; minute: number; day: string } {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((p) => [p.type, p.value]));
    return { hour: Number(parts.hour), minute: Number(parts.minute), day: `${parts.year}-${parts.month}-${parts.day}` };
  } catch {
    return { hour: now.getUTCHours(), minute: now.getUTCMinutes(), day: now.toISOString().slice(0, 10) };
  }
}

registerTaskHandler('notify.urgent', async (ctx) => ({ sent: await notifyUrgent(ctx) }));
registerTaskHandler('digest.daily', async (ctx) => {
  const digest = await buildDigest(ctx);
  const [u] = await ctx.db.select({ timezone: users.timezone }).from(users).where(eq(users.id, ctx.userId));
  const res = await notify(ctx, { kind: 'digest', title: digest.title, body: digest.body, link: '/', dedupKey: `digest:${localClock(ctx.now(), u?.timezone ?? 'Europe/Paris').day}` });
  return { sent: res.sent, failed: res.failed };
});

registerRecurringJob({
  name: 'notify.urgent',
  async isDue(ctx, userId, lastRunAt, now) {
    if (lastRunAt && now.getTime() - lastRunAt.getTime() < 5 * 60_000) return false;
    return (await enabledChannels(forUser(ctx, userId))).length > 0;
  },
  async run(ctx, userId, now) {
    await enqueue(ctx.db, { type: 'notify.urgent', userId, idempotencyKey: `notify.urgent:${userId}`, runAfter: now, priority: 90, maxAttempts: 2 });
  },
});

registerRecurringJob({
  name: 'digest.daily',
  async isDue(ctx, userId, lastRunAt, now) {
    const s = await getSetting(ctx.db, userId, 'schedule.digest');
    if (!s.enabled || !(await enabledChannels(forUser(ctx, userId))).length) return false;
    const [u] = await ctx.db.select({ timezone: users.timezone }).from(users).where(eq(users.id, userId));
    const tz = u?.timezone ?? 'Europe/Paris';
    const local = localClock(now, tz);
    if (local.hour * 60 + local.minute < s.hour * 60 + s.minute) return false;
    // Une fois par jour local.
    return !lastRunAt || localClock(lastRunAt, tz).day !== local.day;
  },
  async run(ctx, userId, now) {
    await enqueue(ctx.db, { type: 'digest.daily', userId, idempotencyKey: `digest.daily:${userId}`, runAfter: now, priority: 50, maxAttempts: 2 });
  },
});


