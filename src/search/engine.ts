// Moteur de collecte : exécute une source, enregistre les offres pertinentes, tient
// l'historique des recherches et la couverture réelle, détecte les offres retirées
// et surveille la santé des sources.
//  - Une source n'est déclarée « lue en entier » que si son connecteur l'affirme :
//    plafond atteint, page en erreur ou flux partiel donnent une couverture « partielle »,
//    avec la raison. Rien n'est présenté comme exhaustif sans l'être.
//  - Une offre n'est considérée comme retirée d'une source qu'après une lecture complète
//    de cette source où elle n'apparaît plus.
//  - Un refus d'accès n'est jamais contourné : la source passe « en panne » et l'utilisateur est prévenu.
import { and, desc, eq, inArray, isNull, lt, notInArray, sql } from 'drizzle-orm';
import type { UserContext } from '../core/context.js';
import { logActivity } from '../core/activity.js';
import { ConfigError } from '../core/errors.js';
import { raiseAction, resolveAction, resolveActionsFor } from '../core/inbox.js';
import { enqueue } from '../core/queue.js';
import { getSecret, type SecretKey } from '../core/secrets.js';
import { normalize } from '../core/text.js';
import { newId } from '../db/ids.js';
import { jobSightings, jobs, searchProfiles, sourceRuns, sources } from '../db/schema.js';
import { SearchCriteria } from '../shared/search.js';
import { isSubmitted, type Stage } from '../shared/stages.js';
import { applyCriteria } from '../pipeline/qualify.js';
import { setStage } from '../tracker/stage.js';
import { getConnector } from './connectors/index.js';
import { FetchError } from './http.js';
import { ingestJob, normalizeJob, type RawJob, type Source } from './ingest.js';
import { expandTitles, searchTerms, titleAffinity } from './synonyms.js';

export type SourceRun = typeof sourceRuns.$inferSelect;

export async function activeCriteria(ctx: UserContext): Promise<{ name: string; criteria: SearchCriteria }[]> {
  const rows = await ctx.db.select().from(searchProfiles).where(and(eq(searchProfiles.userId, ctx.userId), eq(searchProfiles.enabled, true)));
  return rows.map((r) => ({ name: r.name, criteria: SearchCriteria.parse(r.config ?? {}) }));
}

/**
 * Une offre lue sur une source vaut-elle d'être enregistrée ? Elle doit ressembler à
 * un intitulé visé (synonymes compris) ou contenir un mot-clé souhaité, et ne violer
 * aucune règle explicite d'au moins une recherche. Tolérant : en cas de doute, on garde.
 */
export function isRelevant(raw: RawJob, profiles: { criteria: SearchCriteria; targets: string[] }[], now: Date, threshold = 0.6): { relevant: boolean; reason: string } {
  const n = normalizeJob({ ...raw, descriptionHtml: undefined, descriptionText: (raw.descriptionText ?? '').slice(0, 2000) });
  const title = ` ${normalize(raw.title)} `;
  let best = 'intitulé éloigné de vos recherches';
  for (const p of profiles) {
    const affinity = p.targets.length ? titleAffinity(raw.title, p.targets) : 0;
    const keyword = p.criteria.keywords.find((k) => title.includes(` ${normalize(k)} `));
    if (affinity < threshold && !keyword) continue;
    const verdict = applyCriteria({ title: n.title, country: n.country, city: n.city, remote: n.remote, contractType: n.contractType, seniority: n.seniority, yearsMin: n.yearsMin, language: '', postedAt: n.postedAt, descriptionText: '' }, p.criteria, now);
    if (!verdict.excluded) return { relevant: true, reason: '' };
    best = verdict.reasons[0] ?? best;
  }
  return { relevant: false, reason: best };
}

const DISCOVERY: Stage[] = ['new', 'to_analyze', 'analyzed', 'awaiting_feedback', 'filtered'];

/** Après une lecture complète : les offres que la source ne publie plus sont marquées, puis expirées si plus aucune source ne les porte. */
async function detectGone(ctx: UserContext, source: Source, runId: string, seen: Set<string>): Promise<number> {
  const now = ctx.now();
  const active = await ctx.db.select().from(jobSightings).where(and(eq(jobSightings.sourceId, source.id), isNull(jobSightings.goneAt)));
  const gone = active.filter((s) => !seen.has(s.externalId));
  if (!gone.length) return 0;
  await ctx.db.update(jobSightings).set({ goneAt: now, lastRunId: runId }).where(inArray(jobSightings.id, gone.map((g) => g.id)));
  let expired = 0;
  for (const jobId of new Set(gone.map((g) => g.jobId))) {
    const [left] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(jobSightings).where(and(eq(jobSightings.jobId, jobId), isNull(jobSightings.goneAt)));
    if ((left?.n ?? 0) > 0) continue;
    const [job] = await ctx.db.select().from(jobs).where(eq(jobs.id, jobId));
    if (!job || job.expiredAt || isSubmitted(job.stage)) continue;
    await ctx.db.update(jobs).set({ expiredAt: now, updatedAt: now }).where(eq(jobs.id, jobId));
    expired++;
    if (DISCOVERY.includes(job.stage)) {
      await setStage(ctx, jobId, 'expired', { actor: 'agent:search', reason: `retirée de ${source.name}`, soft: true });
      await resolveActionsFor(ctx.db, ctx.userId, { jobId, types: ['job.review'] }, { expired: true });
    } else {
      // Candidature en préparation : le travail n'est pas jeté, l'utilisateur est prévenu.
      await raiseAction(ctx.db, { userId: ctx.userId, type: 'system.alert', title: `Offre retirée : ${job.companyName} — ${job.title}`, body: { text: "Cette offre n'apparaît plus sur sa source alors que votre candidature était en préparation. Vérifiez si elle est toujours ouverte avant de postuler.", link: `/offres/${jobId}` }, jobId, priority: 80, dedupKey: `job.gone:${jobId}` });
    }
  }
  return expired;
}

export interface RunResult {
  run: SourceRun;
  created: string[];
}

export async function runSource(ctx: UserContext, sourceId: string, opts: { trigger?: 'schedule' | 'manual'; budgetMs?: number; maxRequests?: number } = {}): Promise<RunResult> {
  const [source] = await ctx.db.select().from(sources).where(and(eq(sources.id, sourceId), eq(sources.userId, ctx.userId)));
  if (!source) throw new Error('Source introuvable.');
  const connector = getConnector(source.type);
  if (!connector) throw new Error(`Type de source inconnu : ${source.type}`);
  const now = ctx.now();
  const profiles = (await activeCriteria(ctx)).map((p) => ({ ...p, targets: expandTitles(p.criteria.titles) }));
  const runId = newId('run');
  await ctx.db.insert(sourceRuns).values({ id: runId, userId: ctx.userId, sourceId, trigger: opts.trigger ?? 'schedule', status: 'running', startedAt: now });
  const counters = { seen: 0, relevant: 0, created: 0, updated: 0, duplicate: 0, details: 0 };
  const created: string[] = [];
  const seen = new Set<string>();
  const finish = async (patch: Partial<typeof sourceRuns.$inferInsert>) => {
    const [row] = await ctx.db
      .update(sourceRuns)
      .set({ itemsSeen: counters.seen, itemsRelevant: counters.relevant, itemsNew: counters.created, itemsUpdated: counters.updated, itemsDuplicate: counters.duplicate, finishedAt: ctx.now(), ...patch })
      .where(eq(sourceRuns.id, runId))
      .returning();
    return row!;
  };

  try {
    if (!profiles.length || profiles.every((p) => !p.criteria.titles.length && !p.criteria.keywords.length)) {
      throw new ConfigError('Définissez au moins une recherche avec un intitulé visé (Recherche → Critères) : sans elle, aucune offre ne peut être sélectionnée.', 'search_criteria');
    }
    const config = connector.configSchema.parse(source.config ?? {});
    const secrets: Partial<Record<SecretKey, string>> = {};
    for (const s of connector.secrets ?? []) {
      const v = await getSecret(ctx.db, ctx.env.appSecret, ctx.userId, s.key);
      if (v) secrets[s.key] = v;
    }
    const started = Date.now();
    const budgetMs = opts.budgetMs ?? 150_000;
    const threshold = connector.mode === 'search' ? 0.5 : 0.6;
    const out = await connector.run(ctx, {
      config,
      criteria: profiles.map((p) => p.criteria),
      terms: searchTerms(profiles.flatMap((p) => p.criteria.titles)),
      secrets,
      maxRequests: opts.maxRequests ?? 60,
      emit: async (raw) => {
        // Une même offre peut remonter par plusieurs requêtes d'une même collecte : elle n'est comptée et traitée qu'une fois.
        if (raw.externalId && seen.has(raw.externalId)) return Date.now() - started < budgetMs;
        counters.seen++;
        if (raw.externalId) seen.add(raw.externalId);
        if (!raw.title?.trim()) return true;
        if (!isRelevant(raw, profiles, now, threshold).relevant) return Date.now() - started < budgetMs;
        counters.relevant++;
        let job = raw;
        // Texte complet à charger à part (plateformes dont la liste ne le contient pas) : uniquement pour une offre encore inconnue.
        if (connector.detail && !raw.descriptionHtml && !raw.descriptionText && raw.externalId) {
          const [known] = await ctx.db.select({ id: jobSightings.id }).from(jobSightings).where(and(eq(jobSightings.sourceId, source.id), eq(jobSightings.externalId, raw.externalId)));
          if (!known && counters.details < 80) {
            counters.details++;
            try {
              job = await connector.detail(ctx, config, raw);
            } catch (err) {
              ctx.log.warn('source_detail_failed', { source: source.id, error: String(err) });
            }
          }
        }
        if (!job.company?.trim()) return Date.now() - started < budgetMs;
        const res = await ingestJob(ctx, job, { source, runId, actor: 'agent:search', flags: connector.partialDescriptions ? { partialDescription: true } : undefined });
        if (res.outcome === 'created') {
          counters.created++;
          created.push(res.job.id);
          await enqueue(ctx.db, { type: 'job.qualify', userId: ctx.userId, payload: { jobId: res.job.id }, idempotencyKey: `job.qualify:${res.job.id}`, priority: 40, runAfter: ctx.now() });
        } else if (res.outcome === 'updated') counters.updated++;
        else counters.duplicate++;
        return Date.now() - started < budgetMs;
      },
    });
    const expired = out.complete ? await detectGone(ctx, source, runId, seen) : 0;
    const run = await finish({ status: out.complete ? 'complete' : 'partial', incompleteReason: out.incompleteReason ?? '', pagesFetched: out.pages, requests: out.requests + counters.details, queries: out.queries, itemsExpired: expired });
    const done = ctx.now();
    await ctx.db
      .update(sources)
      .set({ health: 'ok', consecutiveFailures: 0, lastRunAt: done, lastSuccessAt: done, lastError: '', ...(out.complete ? { lastCompleteAt: done } : {}) })
      .where(eq(sources.id, source.id));
    await resolveAction(ctx.db, ctx.userId, { dedupKey: `source.down:${source.id}` }, { recovered: true });
    await resolveAction(ctx.db, ctx.userId, { dedupKey: `source.config:${source.id}` }, { recovered: true });
    await logActivity(ctx.db, { userId: ctx.userId, actor: 'agent:search', action: 'source.run', summary: `${source.name} : ${counters.seen} offre(s) lue(s), ${counters.relevant} pertinente(s), ${counters.created} nouvelle(s)${expired ? `, ${expired} retirée(s)` : ''}${out.complete ? '' : ` — lecture partielle (${out.incompleteReason})`}`, entityType: 'source', entityId: source.id, data: { runId, ...counters } });
    return { run, created };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const config = err instanceof ConfigError;
    const failures = config ? source.consecutiveFailures : source.consecutiveFailures + 1;
    const run = await finish({ status: 'failed', error: message.slice(0, 1000) });
    await ctx.db
      .update(sources)
      .set({ health: config ? 'needs_config' : failures >= 3 || (err instanceof FetchError && err.kind === 'blocked') ? 'failing' : 'degraded', consecutiveFailures: failures, lastRunAt: ctx.now(), lastError: message.slice(0, 1000) })
      .where(eq(sources.id, source.id));
    if (config) {
      const criteria = (err as ConfigError).what === 'search_criteria';
      await raiseAction(ctx.db, {
        userId: ctx.userId,
        type: criteria ? 'setup.search' : 'system.alert',
        title: criteria ? 'Définir votre recherche' : `Source à configurer : ${source.name}`,
        body: { text: message, link: criteria ? '/recherche' : '/recherche/sources' },
        priority: criteria ? 94 : 82,
        dedupKey: criteria ? 'setup.search' : `source.config:${source.id}`,
        reopen: true,
      });
      throw err;
    }
    if (failures >= 3 || (err instanceof FetchError && err.kind === 'blocked')) {
      await raiseAction(ctx.db, { userId: ctx.userId, type: 'system.alert', title: `Source en panne : ${source.name}`, body: { text: `${message} Les autres sources continuent de fonctionner ; celle-ci sera réessayée à la prochaine échéance.`, link: '/recherche/sources' }, priority: 78, dedupKey: `source.down:${source.id}`, reopen: true });
    }
    await logActivity(ctx.db, { userId: ctx.userId, actor: 'agent:search', action: 'source.failed', level: 'warn', summary: `${source.name} : ${message}`, entityType: 'source', entityId: source.id, data: { runId } });
    return { run, created };
  }
}

/** Sources dont l'échéance est atteinte (hors source manuelle). */
export async function dueSources(ctx: UserContext, minIntervalMinutes: number): Promise<Source[]> {
  const now = ctx.now().getTime();
  const rows = await ctx.db.select().from(sources).where(and(eq(sources.userId, ctx.userId), eq(sources.enabled, true), notInArray(sources.type, ['manual', 'email'])));
  return rows.filter((s) => !s.lastRunAt || now - s.lastRunAt.getTime() >= Math.max(s.intervalMinutes, minIntervalMinutes) * 60_000);
}

/** Tableau de couverture : pour chaque source, ce qui a réellement été lu, quand, et avec quelles limites. */
export async function coverage(ctx: UserContext) {
  const list = await ctx.db.select().from(sources).where(eq(sources.userId, ctx.userId)).orderBy(sources.createdAt);
  const out = [];
  for (const s of list) {
    const [last] = await ctx.db.select().from(sourceRuns).where(eq(sourceRuns.sourceId, s.id)).orderBy(desc(sourceRuns.startedAt)).limit(1);
    const [live] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(jobSightings).where(and(eq(jobSightings.sourceId, s.id), isNull(jobSightings.goneAt)));
    const connector = getConnector(s.type);
    out.push({
      id: s.id,
      type: s.type,
      name: s.name,
      label: connector?.label ?? (s.type === 'manual' ? 'Ajout manuel' : s.type),
      mode: connector?.mode ?? 'manual',
      access: connector?.access ?? "Offres ajoutées par vous-même",
      enabled: s.enabled,
      health: s.health,
      intervalMinutes: s.intervalMinutes,
      config: s.config,
      lastRunAt: s.lastRunAt,
      lastSuccessAt: s.lastSuccessAt,
      lastCompleteAt: s.lastCompleteAt,
      lastError: s.lastError,
      liveJobs: live?.n ?? 0,
      lastRun: last ? { status: last.status, startedAt: last.startedAt, itemsSeen: last.itemsSeen, itemsRelevant: last.itemsRelevant, itemsNew: last.itemsNew, itemsExpired: last.itemsExpired, requests: last.requests, incompleteReason: last.incompleteReason, error: last.error } : null,
    });
  }
  return out;
}

/** Purge de l'historique des recherches au-delà de 90 jours (les offres et leurs observations sont conservées). */
export async function pruneRuns(ctx: UserContext): Promise<void> {
  await ctx.db.delete(sourceRuns).where(and(eq(sourceRuns.userId, ctx.userId), lt(sourceRuns.startedAt, new Date(ctx.now().getTime() - 90 * 86400_000))));
}
