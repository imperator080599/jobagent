// Synthèses pour l'interface : compteurs de navigation, consommation IA.
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { actionItems, llmCalls, tasks } from '../../db/schema.js';
import { type AppDeps, router } from '../http.js';

export function overviewRoutes(deps: AppDeps) {
  const r = router();
  const { ctx } = deps;

  r.get('/counts', async (c) => {
    const userId = c.get('user').id;
    const [inbox] = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(actionItems)
      .where(and(eq(actionItems.userId, userId), eq(actionItems.status, 'open')));
    const [working] = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(tasks)
      .where(and(eq(tasks.userId, userId), inArray(tasks.status, ['queued', 'running'])));
    return c.json({ inbox: inbox?.n ?? 0, working: working?.n ?? 0 });
  });

  r.get('/llm-usage', async (c) => {
    const userId = c.get('user').id;
    const now = ctx.now();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const rows = await ctx.db
      .select({ purpose: llmCalls.purpose, usd: sql<number>`coalesce(sum(${llmCalls.costUsd}), 0)::float8`, calls: sql<number>`count(*)::int` })
      .from(llmCalls)
      .where(and(eq(llmCalls.userId, userId), gte(llmCalls.createdAt, monthStart)))
      .groupBy(llmCalls.purpose);
    const [today] = await ctx.db
      .select({ usd: sql<number>`coalesce(sum(${llmCalls.costUsd}), 0)::float8` })
      .from(llmCalls)
      .where(and(eq(llmCalls.userId, userId), gte(llmCalls.createdAt, dayStart)));
    return c.json({
      monthUsd: rows.reduce((a, r) => a + r.usd, 0),
      todayUsd: today?.usd ?? 0,
      calls: rows.reduce((a, r) => a + r.calls, 0),
      byPurpose: rows.sort((a, b) => b.usd - a.usd),
    });
  });

  return r;
}
