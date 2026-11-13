// Point d'entrée IA des agents. Ajoute autour du fournisseur :
//  - le choix du modèle (principal / économique) selon les paramètres de l'utilisateur ;
//  - le garde-fou budgétaire (plafonds quotidien et mensuel) ;
//  - l'enregistrement de chaque appel (tokens, coût, durée) pour le suivi des coûts.
import { and, eq, gte, sql } from 'drizzle-orm';
import type { UserContext } from '../core/context.js';
import { ConfigError } from '../core/errors.js';
import { errorMessage } from '../core/log.js';
import { getSecret } from '../core/secrets.js';
import { getSetting } from '../core/settings.js';
import { newId } from '../db/ids.js';
import { llmCalls } from '../db/schema.js';
import { createAnthropicProvider } from './anthropic.js';
import { createCliProvider } from './cli.js';
import { createMockProvider } from './mock.js';
import { costUsd, type Usage } from './pricing.js';
import type { Llm, LlmJsonRequest, LlmProvider, LlmRequest } from './types.js';

export * from './types.js';
export { UNTRUSTED_RULE, detectInjection, wrapUntrusted, type InjectionFinding } from './safety.js';

export async function llmSpend(ctx: UserContext): Promise<{ todayUsd: number; monthUsd: number }> {
  const now = ctx.now();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [row] = await ctx.db
    .select({
      month: sql<number>`coalesce(sum(${llmCalls.costUsd}), 0)::float8`,
      today: sql<number>`coalesce(sum(case when ${llmCalls.createdAt} >= ${dayStart} then ${llmCalls.costUsd} else 0 end), 0)::float8`,
    })
    .from(llmCalls)
    .where(and(eq(llmCalls.userId, ctx.userId), gte(llmCalls.createdAt, monthStart)));
  return { todayUsd: row?.today ?? 0, monthUsd: row?.month ?? 0 };
}

/** Indique si l'IA est utilisable pour cet utilisateur (clé présente ou mode simulé). */
export async function llmAvailability(ctx: UserContext): Promise<{ available: boolean; provider: string; reason?: string }> {
  const provider = ctx.env.llmProvider;
  if (provider !== 'anthropic') return { available: true, provider };
  const key = (await getSecret(ctx.db, ctx.env.appSecret, ctx.userId, 'anthropic_api_key')) ?? ctx.env.anthropicApiKey;
  return key ? { available: true, provider } : { available: false, provider, reason: 'llm_key_missing' };
}

async function resolveProvider(ctx: UserContext): Promise<LlmProvider> {
  if (ctx.env.llmProvider === 'claude-cli') return createCliProvider();
  if (ctx.env.llmProvider === 'mock') return createMockProvider();
  const key = (await getSecret(ctx.db, ctx.env.appSecret, ctx.userId, 'anthropic_api_key')) ?? ctx.env.anthropicApiKey;
  if (!key) throw new ConfigError("Aucune clé d'API Anthropic n'est configurée (Paramètres → IA et budget).", 'llm_key_missing');
  return createAnthropicProvider(key, { fetch: ctx.fetch });
}

export async function getLlm(ctx: UserContext): Promise<Llm> {
  const provider = await resolveProvider(ctx);
  const models = await getSetting(ctx.db, ctx.userId, 'llm.models');
  const budget = await getSetting(ctx.db, ctx.userId, 'llm.budget');

  const guardBudget = async () => {
    if (provider.name === 'mock') return;
    const spend = await llmSpend(ctx);
    if (budget.monthlyUsd > 0 && spend.monthUsd >= budget.monthlyUsd) {
      throw new ConfigError(`Budget IA mensuel atteint (${spend.monthUsd.toFixed(2)} $ sur ${budget.monthlyUsd} $). Relevez le plafond ou attendez le mois prochain.`, 'llm_budget_month');
    }
    if (budget.dailyUsd > 0 && spend.todayUsd >= budget.dailyUsd) {
      throw new ConfigError(`Budget IA quotidien atteint (${spend.todayUsd.toFixed(2)} $ sur ${budget.dailyUsd} $). Les tâches reprendront demain.`, 'llm_budget_day');
    }
  };

  const record = async (req: LlmRequest, model: string, started: number, r: { usage: Usage; stopReason: string; refused: boolean } | null, error?: unknown) => {
    const usage = r?.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const cost = costUsd(model, usage);
    await ctx.db.insert(llmCalls).values({
      id: newId('llm'),
      userId: ctx.userId || null,
      purpose: req.purpose,
      provider: provider.name,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      costUsd: cost,
      durationMs: Date.now() - started,
      status: error ? 'error' : r?.refused ? 'refused' : 'ok',
      stopReason: r?.stopReason ?? '',
      error: error ? errorMessage(error).slice(0, 500) : '',
      jobId: req.jobId ?? null,
    });
    return { costUsd: cost, durationMs: Date.now() - started };
  };

  const modelFor = (req: LlmRequest) => (provider.name === 'mock' ? 'mock' : req.tier === 'main' ? models.main : models.bulk);

  return {
    provider: provider.name,
    async text(req) {
      await guardBudget();
      const model = modelFor(req);
      const started = Date.now();
      try {
        const r = await provider.text(req, model);
        return { ...r, ...(await record(req, r.model || model, started, r)) };
      } catch (err) {
        if (!(err instanceof ConfigError)) await record(req, model, started, null, err);
        throw err;
      }
    },
    async json<T>(req: LlmJsonRequest<T>) {
      await guardBudget();
      const model = modelFor(req);
      const started = Date.now();
      try {
        const r = await provider.json(req, model);
        return { ...r, ...(await record(req, r.model || model, started, r)) };
      } catch (err) {
        if (!(err instanceof ConfigError)) await record(req, model, started, null, err);
        throw err;
      }
    },
  };
}
