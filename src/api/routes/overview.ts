// Synthèses pour l'interface : compteurs de navigation, consommation IA.
import { and, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { listActivity } from '../../core/activity.js';
import { getSetting } from '../../core/settings.js';
import { actionItems, applications, jobs, llmCalls, tasks } from '../../db/schema.js';
import { llmSpend } from '../../llm/index.js';
import { STAGE_GROUPS, SUBMITTED_STAGES } from '../../shared/stages.js';
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

  /** Tableau de bord : où en est chaque offre, ce qui presse, ce que l'agent a fait. */
  r.get('/dashboard', async (c) => {
    const userId = c.get('user').id;
    const uctx = c.get('uctx');
    const now = ctx.now();
    const weekAgo = new Date(now.getTime() - 7 * 86400_000);
    const soon = new Date(now.getTime() + 10 * 86400_000);
    const card = { id: jobs.id, title: jobs.title, companyName: jobs.companyName, city: jobs.city, country: jobs.country, locationRaw: jobs.locationRaw, remote: jobs.remote, stage: jobs.stage, atsScore: jobs.atsScore, atsDecision: jobs.atsDecision, priorityScore: jobs.priorityScore, deadlineAt: jobs.deadlineAt, strategic: jobs.strategic };
    const [byStage, [fresh], top, deadlines, followUps, [sentWeek], blocked, spend, budget, activity] = await Promise.all([
      ctx.db.select({ stage: jobs.stage, n: sql<number>`count(*)::int` }).from(jobs).where(eq(jobs.userId, userId)).groupBy(jobs.stage),
      ctx.db.select({ n: sql<number>`count(*)::int` }).from(jobs).where(and(eq(jobs.userId, userId), gte(jobs.firstSeenAt, weekAgo))),
      ctx.db.select(card).from(jobs).where(and(eq(jobs.userId, userId), inArray(jobs.stage, ['awaiting_feedback', 'ready_to_apply']))).orderBy(sql`${jobs.priorityScore} desc nulls last`).limit(6),
      ctx.db
        .select(card)
        .from(jobs)
        .where(and(eq(jobs.userId, userId), isNotNull(jobs.deadlineAt), gte(jobs.deadlineAt, now), lte(jobs.deadlineAt, soon), sql`${jobs.stage} not in ('filtered', 'expired', 'abandoned', 'sent', 'confirmed', 'interview_hr', 'interview_tech', 'offer', 'rejected', 'no_response', 'follow_up_needed')`))
        .orderBy(jobs.deadlineAt)
        .limit(5),
      ctx.db
        .select({ jobId: jobs.id, title: jobs.title, companyName: jobs.companyName, stage: jobs.stage, followUpDueAt: applications.followUpDueAt, submittedAt: applications.submittedAt })
        .from(applications)
        .innerJoin(jobs, eq(jobs.id, applications.jobId))
        .where(and(eq(applications.userId, userId), isNotNull(applications.followUpDueAt), lte(applications.followUpDueAt, now), inArray(jobs.stage, ['sent', 'confirmed', 'follow_up_needed'])))
        .orderBy(applications.followUpDueAt)
        .limit(5),
      ctx.db.select({ n: sql<number>`count(*)::int` }).from(applications).where(and(eq(applications.userId, userId), gte(applications.submittedAt, weekAgo))),
      ctx.db.select({ type: tasks.type, lastError: tasks.lastError }).from(tasks).where(and(eq(tasks.userId, userId), eq(tasks.status, 'blocked'))).limit(20),
      llmSpend(uctx),
      getSetting(ctx.db, userId, 'llm.budget'),
      listActivity(ctx.db, userId, { limit: 12 }),
    ]);
    const counts = Object.fromEntries(byStage.map((s) => [s.stage, s.n])) as Record<string, number>;
    const sum = (stages: readonly string[]) => stages.reduce((n, s) => n + (counts[s] ?? 0), 0);
    return c.json({
      pipeline: {
        discovery: sum(STAGE_GROUPS.discovery),
        decision: sum(STAGE_GROUPS.decision),
        preparation: sum(STAGE_GROUPS.preparation),
        submitted: sum(SUBMITTED_STAGES),
        interviews: sum(STAGE_GROUPS.interviews),
        offers: counts.offer ?? 0,
        filtered: (counts.filtered ?? 0) + (counts.expired ?? 0),
        total: byStage.reduce((n, s) => n + s.n, 0),
      },
      newThisWeek: fresh?.n ?? 0,
      sentThisWeek: sentWeek?.n ?? 0,
      top,
      deadlines,
      followUps,
      blocked: blocked.map((b) => ({ type: b.type, reason: b.lastError.replace(/^\[[^\]]+\]\s*/, '') })),
      llm: { ...spend, monthlyBudget: budget.monthlyUsd, dailyBudget: budget.dailyUsd },
      activity: activity.map((a) => ({ id: a.id, at: a.at, actor: a.actor, action: a.action, summary: a.summary, level: a.level, entityType: a.entityType, entityId: a.entityId })),
    });
  });

  return r;
}
