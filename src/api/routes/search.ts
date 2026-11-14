// Recherche : critères, sources, entreprises ciblées, couverture et historique des collectes.
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { logActivity } from '../../core/activity.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { resolveAction } from '../../core/inbox.js';
import { enqueue, unblockByReason } from '../../core/queue.js';
import { listSecretHints } from '../../core/secrets.js';
import { newId } from '../../db/ids.js';
import { companies, searchProfiles, sourceRuns, sources } from '../../db/schema.js';
import { CONNECTORS, detectConnector, getConnector } from '../../search/connectors/index.js';
import { coverage } from '../../search/engine.js';
import { companyKey } from '../../search/normalize.js';
import { BUILTIN_SYNONYMS, expandTitles } from '../../search/synonyms.js';
import { SearchCriteria } from '../../shared/search.js';
import { type AppDeps, body, router } from '../http.js';
import { sessionOnly } from '../middleware.js';

export function searchRoutes(deps: AppDeps) {
  const r = router();
  const { ctx } = deps;

  // ── Critères de recherche ──
  r.get('/profiles', async (c) => {
    const rows = await ctx.db.select().from(searchProfiles).where(eq(searchProfiles.userId, c.get('user').id)).orderBy(searchProfiles.createdAt);
    return c.json({ profiles: rows.map((p) => ({ id: p.id, name: p.name, enabled: p.enabled, criteria: SearchCriteria.parse(p.config ?? {}), variants: expandTitles(SearchCriteria.parse(p.config ?? {}).titles).length })), synonyms: BUILTIN_SYNONYMS });
  });

  const ProfileInput = z.object({ name: z.string().trim().min(1).max(80), enabled: z.boolean().default(true), criteria: SearchCriteria });
  r.post('/profiles', sessionOnly, async (c) => {
    const input = await body(c, ProfileInput);
    const userId = c.get('user').id;
    const [row] = await ctx.db.insert(searchProfiles).values({ id: newId('sp'), userId, name: input.name, enabled: input.enabled, config: input.criteria }).returning();
    await resolveAction(ctx.db, userId, { dedupKey: 'setup.search' }, { profileId: row!.id });
    await unblockByReason(ctx.db, userId, ['search_criteria']);
    return c.json({ profile: row });
  });
  r.put('/profiles/:id', sessionOnly, async (c) => {
    const input = await body(c, ProfileInput);
    const userId = c.get('user').id;
    const [row] = await ctx.db.update(searchProfiles).set({ name: input.name, enabled: input.enabled, config: input.criteria, updatedAt: ctx.now() }).where(and(eq(searchProfiles.id, c.req.param('id')), eq(searchProfiles.userId, userId))).returning();
    if (!row) throw notFound();
    await unblockByReason(ctx.db, userId, ['search_criteria']);
    return c.json({ profile: row });
  });
  r.delete('/profiles/:id', sessionOnly, async (c) => {
    await ctx.db.delete(searchProfiles).where(and(eq(searchProfiles.id, c.req.param('id')), eq(searchProfiles.userId, c.get('user').id)));
    return c.json({ ok: true });
  });
  /** Aperçu des variantes d'intitulés qui seront recherchées. */
  r.post('/expand', async (c) => {
    const input = await body(c, z.object({ titles: z.array(z.string()).max(80) }));
    return c.json({ variants: expandTitles(input.titles) });
  });

  // ── Sources ──
  r.get('/connectors', async (c) => {
    const hints = await listSecretHints(ctx.db, c.get('user').id);
    return c.json({ connectors: CONNECTORS.map((k) => ({ type: k.type, label: k.label, mode: k.mode, description: k.description, access: k.access, fields: k.fields, partialDescriptions: Boolean(k.partialDescriptions), secrets: (k.secrets ?? []).map((s) => ({ ...s, configured: Boolean(hints[s.key]), hint: hints[s.key]?.hint ?? '' , help: s.hint ?? '' })) })) });
  });
  r.post('/detect', async (c) => {
    const input = await body(c, z.object({ url: z.string().trim().min(4).max(2000) }));
    const hit = detectConnector(input.url);
    return c.json(hit ? { type: hit.connector.type, label: hit.connector.label, config: hit.config, name: hit.name } : { type: null });
  });
  r.get('/sources', async (c) => c.json({ sources: await coverage(c.get('uctx')) }));

  const SourceInput = z.object({ type: z.string(), name: z.string().trim().min(1).max(120), config: z.record(z.string(), z.unknown()), intervalMinutes: z.number().int().min(30).max(10080).default(360), enabled: z.boolean().default(true) });
  const validated = (type: string, config: Record<string, unknown>) => {
    const connector = getConnector(type);
    if (!connector) throw badRequest('Type de source inconnu.');
    const parsed = connector.configSchema.safeParse(config);
    if (!parsed.success) throw badRequest(`Configuration invalide : ${parsed.error.issues.map((i) => `${i.path.join('.')} — ${i.message}`).join(' ; ')}`);
    return { connector, config: parsed.data };
  };
  r.post('/sources', sessionOnly, async (c) => {
    const input = await body(c, SourceInput);
    const userId = c.get('user').id;
    const v = validated(input.type, input.config);
    const [dup] = await ctx.db.select({ id: sources.id }).from(sources).where(and(eq(sources.userId, userId), eq(sources.type, input.type), eq(sources.name, input.name)));
    if (dup) throw conflict('Une source de ce type porte déjà ce nom.');
    const [row] = await ctx.db.insert(sources).values({ id: newId('src'), userId, type: input.type, name: input.name, config: v.config, intervalMinutes: input.intervalMinutes, enabled: input.enabled }).returning();
    await logActivity(ctx.db, { userId, actor: 'user', action: 'source.added', summary: `Source ajoutée : ${input.name} (${v.connector.label})`, entityType: 'source', entityId: row!.id });
    await enqueue(ctx.db, { type: 'source.run', userId, payload: { sourceId: row!.id, trigger: 'manual' }, idempotencyKey: `source.run:${row!.id}`, priority: 60, runAfter: ctx.now(), maxAttempts: 2 });
    deps.kick(c);
    return c.json({ source: row });
  });
  r.patch('/sources/:id', sessionOnly, async (c) => {
    const input = await body(c, SourceInput.partial().omit({ type: true }));
    const userId = c.get('user').id;
    const [cur] = await ctx.db.select().from(sources).where(and(eq(sources.id, c.req.param('id')), eq(sources.userId, userId)));
    if (!cur) throw notFound();
    const patch: Partial<typeof sources.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.intervalMinutes !== undefined) patch.intervalMinutes = input.intervalMinutes;
    if (input.config !== undefined) {
      patch.config = validated(cur.type, input.config).config;
      patch.health = 'unknown';
      patch.consecutiveFailures = 0;
    }
    const [row] = await ctx.db.update(sources).set(patch).where(eq(sources.id, cur.id)).returning();
    await unblockByReason(ctx.db, userId, ['source_credentials']);
    return c.json({ source: row });
  });
  r.delete('/sources/:id', sessionOnly, async (c) => {
    const userId = c.get('user').id;
    const [cur] = await ctx.db.select().from(sources).where(and(eq(sources.id, c.req.param('id')), eq(sources.userId, userId)));
    if (!cur) throw notFound();
    if (cur.type === 'manual') throw badRequest('La source « Ajout manuel » ne peut pas être supprimée.');
    // Les offres déjà trouvées restent dans votre base ; seule la collecte s'arrête.
    await ctx.db.delete(sources).where(eq(sources.id, cur.id));
    await resolveAction(ctx.db, userId, { dedupKey: `source.down:${cur.id}` }, { deleted: true });
    await resolveAction(ctx.db, userId, { dedupKey: `source.config:${cur.id}` }, { deleted: true });
    return c.json({ ok: true });
  });
  r.post('/sources/:id/run', sessionOnly, async (c) => {
    const userId = c.get('user').id;
    const [cur] = await ctx.db.select().from(sources).where(and(eq(sources.id, c.req.param('id')), eq(sources.userId, userId)));
    if (!cur || cur.type === 'manual') throw notFound();
    await unblockByReason(ctx.db, userId, ['source_credentials', 'search_criteria']);
    await enqueue(ctx.db, { type: 'source.run', userId, payload: { sourceId: cur.id, trigger: 'manual' }, idempotencyKey: `source.run:${cur.id}`, priority: 70, runAfter: ctx.now(), maxAttempts: 2 });
    deps.kick(c);
    return c.json({ ok: true });
  });
  r.get('/runs', async (c) => {
    const rows = await ctx.db
      .select({ id: sourceRuns.id, sourceId: sourceRuns.sourceId, sourceName: sources.name, trigger: sourceRuns.trigger, status: sourceRuns.status, startedAt: sourceRuns.startedAt, finishedAt: sourceRuns.finishedAt, itemsSeen: sourceRuns.itemsSeen, itemsRelevant: sourceRuns.itemsRelevant, itemsNew: sourceRuns.itemsNew, itemsDuplicate: sourceRuns.itemsDuplicate, itemsExpired: sourceRuns.itemsExpired, requests: sourceRuns.requests, incompleteReason: sourceRuns.incompleteReason, error: sourceRuns.error, queries: sourceRuns.queries })
      .from(sourceRuns)
      .leftJoin(sources, eq(sources.id, sourceRuns.sourceId))
      .where(eq(sourceRuns.userId, c.get('user').id))
      .orderBy(desc(sourceRuns.startedAt))
      .limit(Math.min(200, Number(c.req.query('limit')) || 60));
    return c.json({ runs: rows });
  });

  /** Matrice de couverture : statut réel de chaque source, méthode d'accès, limites et preuves. */
  r.get('/coverage-matrix', async (c) => {
    const { coverageMatrix } = await import('../../search/coverage.js');
    return c.json(await coverageMatrix(c.get('uctx')));
  });

  // ── Entreprises ciblées ──
  r.get('/companies', async (c) => c.json({ companies: await ctx.db.select().from(companies).where(eq(companies.userId, c.get('user').id)).orderBy(companies.name) }));
  const CompanyInput = z.object({ name: z.string().trim().min(1).max(160), tier: z.enum(['dream', 'target', 'watch', 'excluded']).default('target'), careersUrl: z.string().trim().max(2000).default(''), notes: z.string().max(4000).default('') });
  r.post('/companies', sessionOnly, async (c) => {
    const input = await body(c, CompanyInput);
    const userId = c.get('user').id;
    const nameNorm = companyKey(input.name);
    const [row] = await ctx.db
      .insert(companies)
      .values({ id: newId('co'), userId, name: input.name, nameNorm, tier: input.tier, careersUrl: input.careersUrl, notes: input.notes })
      .onConflictDoUpdate({ target: [companies.userId, companies.nameNorm], set: { name: input.name, tier: input.tier, careersUrl: input.careersUrl, notes: input.notes } })
      .returning();
    // Un site carrières reconnu devient aussitôt une source surveillée.
    let source = null;
    const hit = input.careersUrl && input.tier !== 'excluded' ? detectConnector(input.careersUrl) : null;
    if (hit) {
      const cfg = hit.connector.configSchema.safeParse({ ...hit.config, company: input.name, name: input.name });
      if (cfg.success) {
        [source] = await ctx.db.insert(sources).values({ id: newId('src'), userId, type: hit.connector.type, name: input.name, config: cfg.data, companyId: row!.id }).onConflictDoNothing().returning();
        if (source) {
          await enqueue(ctx.db, { type: 'source.run', userId, payload: { sourceId: source.id, trigger: 'manual' }, idempotencyKey: `source.run:${source.id}`, priority: 60, runAfter: ctx.now(), maxAttempts: 2 });
          deps.kick(c);
        }
      }
    }
    return c.json({ company: row, source, detected: hit ? hit.connector.label : null });
  });
  /** Lance la recherche (ou la revérification) du site carrières d'une entreprise. */
  r.post('/companies/:id/discover', sessionOnly, async (c) => {
    const userId = c.get('user').id;
    const [co] = await ctx.db.select({ id: companies.id }).from(companies).where(and(eq(companies.id, c.req.param('id')), eq(companies.userId, userId)));
    if (!co) throw notFound();
    await enqueue(ctx.db, { type: 'company.discover', userId, payload: { companyId: co.id }, idempotencyKey: `company.discover:${co.id}`, priority: 70, runAfter: ctx.now(), maxAttempts: 2 });
    deps.kick(c);
    return c.json({ queued: true });
  });
  /** Ajoute les employeurs de départ (conseil en transactions, banques d'affaires, fonds…). */
  r.post('/companies/seed', sessionOnly, async (c) => {
    const { seedTargetCompanies } = await import('../../search/companies.js');
    return c.json({ added: await seedTargetCompanies(c.get('uctx')) });
  });
  r.delete('/companies/:id', sessionOnly, async (c) => {
    await ctx.db.delete(companies).where(and(eq(companies.id, c.req.param('id')), eq(companies.userId, c.get('user').id)));
    return c.json({ ok: true });
  });

  return r;
}
