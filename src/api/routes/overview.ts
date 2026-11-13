// Synthèses pour l'interface : compteurs de navigation, consommation IA.
import { and, desc, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { listActivity } from '../../core/activity.js';
import { getSetting } from '../../core/settings.js';
import { actionItems, applications, atsAnalyses, jobs, llmCalls, tasks } from '../../db/schema.js';
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

  /** Analytique : entonnoir, taux de réponse, sources utiles, mots-clés les plus souvent manquants, coûts. */
  r.get('/analytics', async (c) => {
    const userId = c.get('user').id;
    const [byStage, bySource, scores, analyses, apps, costs] = await Promise.all([
      ctx.db.select({ stage: jobs.stage, n: sql<number>`count(*)::int` }).from(jobs).where(eq(jobs.userId, userId)).groupBy(jobs.stage),
      ctx.db.execute(sql`select s.name as name, s.type as type, count(distinct j.id)::int as jobs, count(distinct j.id) filter (where j.stage not in ('filtered', 'expired', 'new'))::int as kept, count(distinct j.id) filter (where j.stage in ('sent', 'confirmed', 'interview_hr', 'interview_tech', 'offer', 'rejected', 'no_response', 'follow_up_needed'))::int as applied from sources s left join job_sightings g on g.source_id = s.id left join jobs j on j.id = g.job_id where s.user_id = ${userId} group by s.id, s.name, s.type order by jobs desc`),
      ctx.db.select({ avgAts: sql<number>`avg(${jobs.atsScore})::float8`, avgRelevance: sql<number>`avg(${jobs.relevanceScore})::float8`, avgFit: sql<number>`avg(${jobs.fitScore})::float8`, analyzed: sql<number>`count(${jobs.atsScore})::int` }).from(jobs).where(eq(jobs.userId, userId)),
      ctx.db.select({ parsed: atsAnalyses.parsed }).from(atsAnalyses).where(and(eq(atsAnalyses.userId, userId), eq(atsAnalyses.status, 'ok'))).orderBy(desc(atsAnalyses.createdAt)).limit(200),
      ctx.db.select({ submittedAt: applications.submittedAt, confirmedAt: applications.confirmedAt, lastActivityAt: applications.lastActivityAt, outcome: applications.outcome, stage: jobs.stage, atsScore: jobs.atsScore }).from(applications).innerJoin(jobs, eq(jobs.id, applications.jobId)).where(and(eq(applications.userId, userId), isNotNull(applications.submittedAt))),
      ctx.db.select({ purpose: llmCalls.purpose, usd: sql<number>`coalesce(sum(${llmCalls.costUsd}), 0)::float8`, calls: sql<number>`count(*)::int` }).from(llmCalls).where(eq(llmCalls.userId, userId)).groupBy(llmCalls.purpose),
    ]);
    const counts = Object.fromEntries(byStage.map((s) => [s.stage, s.n])) as Record<string, number>;
    const sum = (stages: readonly string[]) => stages.reduce((n, s) => n + (counts[s] ?? 0), 0);
    const total = byStage.reduce((n, s) => n + s.n, 0);
    const submitted = sum(SUBMITTED_STAGES);
    const interviewsOrBetter = (counts.interview_hr ?? 0) + (counts.interview_tech ?? 0) + (counts.offer ?? 0);
    const answered = apps.filter((a) => ['interview_hr', 'interview_tech', 'offer', 'rejected'].includes(a.stage)).length;
    // Mots-clés le plus souvent signalés absents par vos analyses ATS : ce qu'il vaut la peine d'acquérir ou de mieux formuler.
    const freq = new Map<string, { label: string; n: number }>();
    for (const a of analyses) {
      for (const k of ((a.parsed as { missingKeywords?: string[] } | null)?.missingKeywords ?? []).slice(0, 40)) {
        const key = k.trim().toLowerCase();
        if (!key || key.length > 60) continue;
        const e = freq.get(key) ?? { label: k.trim(), n: 0 };
        e.n++;
        freq.set(key, e);
      }
    }
    const withInterview = apps.filter((a) => ['interview_hr', 'interview_tech', 'offer'].includes(a.stage) && a.atsScore != null);
    const without = apps.filter((a) => !['interview_hr', 'interview_tech', 'offer'].includes(a.stage) && a.atsScore != null);
    const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
    return c.json({
      funnel: [
        { label: 'Offres trouvées', value: total },
        { label: 'Retenues après sélection', value: total - (counts.filtered ?? 0) - (counts.expired ?? 0) - (counts.new ?? 0) },
        { label: 'Analysées (ATS)', value: scores[0]?.analyzed ?? 0 },
        { label: 'Candidatures envoyées', value: submitted },
        { label: 'Entretiens obtenus', value: interviewsOrBetter },
        { label: 'Offres reçues', value: counts.offer ?? 0 },
      ],
      rates: {
        responseRate: submitted ? Math.round((answered / submitted) * 100) : null,
        interviewRate: submitted ? Math.round((interviewsOrBetter / submitted) * 100) : null,
        avgAts: scores[0]?.avgAts != null ? Math.round(scores[0].avgAts * 10) / 10 : null,
        avgRelevance: scores[0]?.avgRelevance != null ? Math.round(scores[0].avgRelevance) : null,
        avgFit: scores[0]?.avgFit != null ? Math.round(scores[0].avgFit) : null,
        avgAtsWithInterview: avg(withInterview.map((a) => a.atsScore!)),
        avgAtsWithoutInterview: avg(without.map((a) => a.atsScore!)),
      },
      sources: (bySource as unknown as { rows?: unknown[] }).rows ?? bySource,
      missingKeywords: [...freq.values()].filter((k) => k.n > 1 || analyses.length < 4).sort((a, b) => b.n - a.n).slice(0, 25),
      analysesCount: analyses.length,
      costs: { total: costs.reduce((a, r) => a + r.usd, 0), byPurpose: costs.sort((a, b) => b.usd - a.usd), perApplication: submitted ? costs.reduce((a, r) => a + r.usd, 0) / submitted : null },
    });
  });

  return r;
}
