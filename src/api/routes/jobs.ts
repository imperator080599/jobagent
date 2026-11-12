// Offres : liste, fiche, ajout manuel, contrôle des doublons, statut.
import { and, asc, desc, eq, gte, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { logActivity } from '../../core/activity.js';
import { badRequest, conflict, HttpError } from '../../core/errors.js';
import { resolveAction } from '../../core/inbox.js';
import { enqueue, unblockTasks } from '../../core/queue.js';
import { actionItems, applications, atsAnalyses, cvVersions, jobSightings, jobs, letters, sources } from '../../db/schema.js';
import { extractJobFields } from '../../search/extract.js';
import { FetchError } from '../../search/http.js';
import { checkExistingJob, ingestJob, manualSource, mergeJobs, normalizeJob, type ExistingJobVerdict, type RawJob } from '../../search/ingest.js';
import { fetchJobPage } from '../../search/page.js';
import { isSubmitted, STAGE_GROUPS, STAGES, type Stage } from '../../shared/stages.js';
import { getJob, listStageHistory, setStage } from '../../tracker/stage.js';
import { recordFeedback, submitReview } from '../../pipeline/review.js';
import { type AppDeps, body, router } from '../http.js';
import { requireScope, sessionOnly } from '../middleware.js';

/** Colonnes de la liste : tout sauf le texte intégral de l'annonce. */
const LIST_COLUMNS = {
  id: jobs.id,
  companyName: jobs.companyName,
  title: jobs.title,
  locationRaw: jobs.locationRaw,
  city: jobs.city,
  country: jobs.country,
  remote: jobs.remote,
  contractType: jobs.contractType,
  seniority: jobs.seniority,
  stage: jobs.stage,
  stageChangedAt: jobs.stageChangedAt,
  relevanceScore: jobs.relevanceScore,
  fitScore: jobs.fitScore,
  priorityScore: jobs.priorityScore,
  strategic: jobs.strategic,
  atsScore: jobs.atsScore,
  atsDecision: jobs.atsDecision,
  starred: jobs.starred,
  userDecision: jobs.userDecision,
  sourcesCount: jobs.sourcesCount,
  postedAt: jobs.postedAt,
  deadlineAt: jobs.deadlineAt,
  firstSeenAt: jobs.firstSeenAt,
  lastSeenAt: jobs.lastSeenAt,
  expiredAt: jobs.expiredAt,
  canonicalUrl: jobs.canonicalUrl,
  applyUrl: jobs.applyUrl,
  flags: jobs.flags,
  qualification: jobs.qualification,
};

const publicVerdict = (v: ExistingJobVerdict) => ({
  exists: v.exists,
  match: v.match,
  alreadyApplied: v.alreadyApplied,
  inProgress: v.inProgress,
  summary: v.summary,
  job: v.job ? { id: v.job.id, title: v.job.title, companyName: v.job.companyName, stage: v.job.stage, locationRaw: v.job.locationRaw } : null,
  possible: v.possible.map((p) => ({ id: p.job.id, title: p.job.title, companyName: p.job.companyName, stage: p.job.stage, locationRaw: p.job.locationRaw, similarity: p.similarity, reason: p.reason })),
});

const AddJob = z.object({
  url: z.string().trim().max(2000).optional(),
  text: z.string().max(200_000).optional(),
  company: z.string().trim().max(200).optional(),
  title: z.string().trim().max(300).optional(),
  location: z.string().trim().max(200).optional(),
});

export function jobsRoutes(deps: AppDeps) {
  const r = router();
  const { ctx } = deps;

  r.get('/', async (c) => {
    const userId = c.get('user').id;
    const q = c.req.query();
    const conds: SQL[] = [eq(jobs.userId, userId)];
    const stageParam = (q.stage ?? '').split(',').filter(Boolean);
    const stages = stageParam.flatMap((s) => (s in STAGE_GROUPS ? STAGE_GROUPS[s as keyof typeof STAGE_GROUPS] : (STAGES as readonly string[]).includes(s) ? [s as Stage] : []));
    if (stages.length) conds.push(inArray(jobs.stage, stages));
    else if (q.all !== '1') conds.push(sql`${jobs.stage} not in ('filtered', 'expired', 'abandoned')`);
    if (q.q?.trim()) {
      const like = `%${q.q.trim().replace(/[%_]/g, '')}%`;
      conds.push(or(ilike(jobs.title, like), ilike(jobs.companyName, like), ilike(jobs.locationRaw, like))!);
    }
    if (q.country) conds.push(eq(jobs.country, q.country.toUpperCase()));
    if (q.contract) conds.push(eq(jobs.contractType, q.contract));
    if (q.starred === '1') conds.push(eq(jobs.starred, true));
    if (q.strategic === '1') conds.push(eq(jobs.strategic, true));
    if (q.minPriority) conds.push(gte(jobs.priorityScore, Number(q.minPriority) || 0));
    const order =
      q.sort === 'recent'
        ? [desc(jobs.firstSeenAt)]
        : q.sort === 'ats'
          ? [sql`${jobs.atsScore} desc nulls last`, desc(jobs.firstSeenAt)]
          : q.sort === 'deadline'
            ? [sql`${jobs.deadlineAt} asc nulls last`, desc(jobs.firstSeenAt)]
            : q.sort === 'updated'
              ? [desc(jobs.stageChangedAt)]
              : [desc(jobs.starred), sql`${jobs.priorityScore} desc nulls last`, desc(jobs.firstSeenAt)];
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
    const offset = Math.max(0, Number(q.offset) || 0);
    const where = and(...conds);
    const [items, [total], byStage] = await Promise.all([
      ctx.db.select(LIST_COLUMNS).from(jobs).where(where).orderBy(...order).limit(limit).offset(offset),
      ctx.db.select({ n: sql<number>`count(*)::int` }).from(jobs).where(where),
      ctx.db.select({ stage: jobs.stage, n: sql<number>`count(*)::int` }).from(jobs).where(eq(jobs.userId, userId)).groupBy(jobs.stage),
    ]);
    return c.json({ items, total: total?.n ?? 0, counts: Object.fromEntries(byStage.map((s) => [s.stage, s.n])) });
  });

  /** CHECK_EXISTING_JOB : l'offre est-elle déjà connue, et une candidature est-elle déjà partie ? */
  r.post('/check', requireScope('capture'), async (c) => {
    const input = await body(c, AddJob);
    if (!input.url && !(input.company && input.title)) throw badRequest("Indiquez l'adresse de l'offre, ou l'entreprise et l'intitulé.");
    const n = normalizeJob({ url: input.url, company: input.company ?? '', title: input.title ?? '', location: input.location, descriptionText: input.text });
    return c.json(publicVerdict(await checkExistingJob(c.get('uctx'), n)));
  });

  /** Ajout manuel : une adresse, un texte collé, ou les deux. Rien n'est créé si l'offre est déjà connue. */
  r.post('/', requireScope('capture'), async (c) => {
    const uctx = c.get('uctx');
    const input = await body(c, AddJob);
    const text = input.text?.trim() ?? '';
    if (!input.url && text.length < 80 && !(input.company && input.title)) throw badRequest("Indiquez l'adresse de l'offre ou collez son texte.");

    // 1. Contrôle par l'adresse seule, avant toute lecture de page.
    if (input.url) {
      const first = await checkExistingJob(uctx, normalizeJob({ url: input.url, company: '', title: '' }));
      if (first.exists) return c.json({ outcome: 'duplicate', job: first.job, verdict: publicVerdict(first) });
    }

    let raw: RawJob | null = null;
    let method = 'manual';
    const notes: string[] = [];
    if (input.url && text.length < 80) {
      try {
        const page = await fetchJobPage(uctx, input.url);
        if (page.closed) notes.push("La page indique que l'offre n'est plus ouverte.");
        if (page.job && page.method === 'structured') {
          raw = page.job;
          method = 'structured';
        } else if (page.pageText.length > 300) {
          const f = await extractJobFields(uctx, page.pageText, { pageTitle: page.pageTitle, siteName: page.siteName });
          raw = { url: input.url, company: f.company, title: page.job?.title || f.title, location: f.location, contractType: f.contract, descriptionText: page.pageText };
          method = f.method;
        }
      } catch (err) {
        if (!(err instanceof FetchError)) throw err;
        throw new HttpError(422, 'page_unreadable', `${err.message} Collez le texte de l'offre pour l'ajouter.`, { kind: err.kind });
      }
      if (!raw) throw new HttpError(422, 'page_unreadable', "Cette page ne contient pas d'offre lisible automatiquement. Collez le texte de l'offre pour l'ajouter.");
    } else {
      const f = input.company && input.title ? { title: input.title, company: input.company, location: input.location ?? '', contract: '', method: 'rules' as const } : await extractJobFields(uctx, text);
      raw = { url: input.url, company: f.company, title: f.title, location: f.location, contractType: f.contract, descriptionText: text };
      method = f.method;
    }
    // Les champs saisis par l'utilisateur priment toujours sur ce qui a été lu.
    if (input.company) raw.company = input.company;
    if (input.title) raw.title = input.title;
    if (input.location) raw.location = input.location;
    if (!raw.title || !raw.company) {
      throw new HttpError(422, 'fields_missing', "L'intitulé ou l'entreprise n'ont pas pu être lus. Complétez-les puis validez.", {
        guess: { title: raw.title, company: raw.company, location: raw.location ?? '' },
      });
    }
    const res = await ingestJob(uctx, raw, { source: await manualSource(uctx), actor: 'user' });
    if (res.outcome === 'created') {
      await enqueue(ctx.db, { type: 'job.qualify', userId: uctx.userId, payload: { jobId: res.job.id, manual: true }, idempotencyKey: `job.qualify:${res.job.id}`, priority: 80, runAfter: ctx.now() });
      deps.kick(c);
    }
    return c.json({ outcome: res.outcome === 'created' ? 'created' : 'duplicate', job: res.job, verdict: publicVerdict(res.verdict), method, notes }, res.outcome === 'created' ? 201 : 200);
  });

  r.get('/:id', async (c) => {
    const uctx = c.get('uctx');
    const job = await getJob(uctx, c.req.param('id'));
    const [sightings, history, analyses, cvs, lets, [application], todo] = await Promise.all([
      ctx.db
        .select({ id: jobSightings.id, url: jobSightings.url, firstSeenAt: jobSightings.firstSeenAt, lastSeenAt: jobSightings.lastSeenAt, goneAt: jobSightings.goneAt, sourceName: sources.name, sourceType: sources.type })
        .from(jobSightings)
        .leftJoin(sources, eq(sources.id, jobSightings.sourceId))
        .where(eq(jobSightings.jobId, job.id))
        .orderBy(asc(jobSightings.firstSeenAt)),
      listStageHistory(uctx, job.id),
      ctx.db.select().from(atsAnalyses).where(and(eq(atsAnalyses.jobId, job.id), eq(atsAnalyses.userId, uctx.userId))).orderBy(desc(atsAnalyses.createdAt)).limit(6),
      ctx.db
        .select({ id: cvVersions.id, label: cvVersions.label, status: cvVersions.status, version: cvVersions.version, changeSummary: cvVersions.changeSummary, checks: cvVersions.checks, pdfFileId: cvVersions.pdfFileId, docxFileId: cvVersions.docxFileId, parentId: cvVersions.parentId, createdAt: cvVersions.createdAt, approvedAt: cvVersions.approvedAt })
        .from(cvVersions)
        .where(and(eq(cvVersions.jobId, job.id), eq(cvVersions.userId, uctx.userId)))
        .orderBy(desc(cvVersions.createdAt)),
      ctx.db.select().from(letters).where(and(eq(letters.jobId, job.id), eq(letters.userId, uctx.userId))).orderBy(desc(letters.createdAt)),
      ctx.db.select().from(applications).where(and(eq(applications.jobId, job.id), eq(applications.userId, uctx.userId))),
      ctx.db.select().from(actionItems).where(and(eq(actionItems.jobId, job.id), eq(actionItems.userId, uctx.userId), inArray(actionItems.status, ['open', 'snoozed']))),
    ]);
    return c.json({ job, sightings, history, analyses, cvVersions: cvs, letters: lets, application: application ?? null, actions: todo });
  });

  r.patch('/:id', sessionOnly, async (c) => {
    const uctx = c.get('uctx');
    const input = await body(
      c,
      z.object({
        starred: z.boolean().optional(),
        notes: z.string().max(20_000).optional(),
        applyUrl: z.string().trim().max(2000).optional(),
        deadlineAt: z.string().nullable().optional(),
        title: z.string().trim().min(2).max(300).optional(),
        companyName: z.string().trim().min(1).max(200).optional(),
        locationRaw: z.string().trim().max(200).optional(),
        descriptionText: z.string().max(200_000).optional(),
      }),
    );
    const job = await getJob(uctx, c.req.param('id'));
    const patch: Partial<typeof jobs.$inferInsert> = { updatedAt: ctx.now() };
    if (input.starred !== undefined) patch.starred = input.starred;
    if (input.notes !== undefined) patch.notes = input.notes;
    if (input.applyUrl !== undefined) patch.applyUrl = input.applyUrl;
    if (input.deadlineAt !== undefined) patch.deadlineAt = input.deadlineAt ? new Date(input.deadlineAt) : null;
    const contentEdit = input.title !== undefined || input.companyName !== undefined || input.locationRaw !== undefined || input.descriptionText !== undefined;
    if (contentEdit) {
      // Correction de la fiche par l'utilisateur : tous les champs dérivés sont recalculés.
      const n = normalizeJob({
        url: job.canonicalUrl || undefined,
        company: input.companyName ?? job.companyName,
        title: input.title ?? job.title,
        location: input.locationRaw ?? job.locationRaw,
        descriptionText: input.descriptionText ?? job.descriptionText,
      });
      const clash = await checkExistingJob(uctx, n, { excludeId: job.id });
      if (clash.exists) throw conflict(`Cette correction ferait doublon avec une offre existante : ${clash.job!.companyName} — ${clash.job!.title}.`, { jobId: clash.job!.id });
      Object.assign(patch, {
        companyName: n.companyName,
        companyNorm: n.companyNorm,
        title: n.title,
        titleNorm: n.titleNorm,
        locationRaw: n.locationRaw,
        city: n.city,
        country: n.country,
        remote: n.remote || job.remote,
        contractType: n.contractType || job.contractType,
        seniority: n.seniority,
        yearsMin: n.yearsMin,
        yearsMax: n.yearsMax,
        language: n.language || job.language,
        descriptionText: n.descriptionText,
        descriptionHash: n.descriptionHash,
        fingerprint: n.fingerprint,
      });
    }
    if (input.descriptionText !== undefined && (job.flags as Record<string, unknown>).partialDescription) {
      // L'utilisateur a fourni le texte complet : l'analyse en attente peut reprendre.
      const flags = { ...job.flags } as Record<string, unknown>;
      delete flags.partialDescription;
      patch.flags = flags;
      await resolveAction(ctx.db, uctx.userId, { dedupKey: `job.needs_text:${job.id}` }, { provided: true });
      await unblockTasks(ctx.db, `job.ats:${job.id}`);
      deps.kick(c);
    }
    const [updated] = await ctx.db.update(jobs).set(patch).where(eq(jobs.id, job.id)).returning();
    if (contentEdit) await logActivity(ctx.db, { userId: uctx.userId, actor: 'user', action: 'job.edited', summary: `${updated!.companyName} — ${updated!.title}`, entityType: 'job', entityId: job.id });
    return c.json({ job: updated });
  });

  r.post('/:id/stage', sessionOnly, async (c) => {
    const input = await body(c, z.object({ to: z.enum(STAGES), reason: z.string().max(500).optional() }));
    const job = await setStage(c.get('uctx'), c.req.param('id'), input.to, { actor: 'user', reason: input.reason });
    return c.json({ job });
  });

  r.post('/:id/merge', sessionOnly, async (c) => {
    const input = await body(c, z.object({ duplicateId: z.string() }));
    try {
      return c.json({ job: await mergeJobs(c.get('uctx'), c.req.param('id'), input.duplicateId) });
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  });

  /** « Ce n'est pas un doublon » : la question n'est plus posée pour ces deux offres. */
  r.post('/:id/not-duplicate', sessionOnly, async (c) => {
    const uctx = c.get('uctx');
    const job = await getJob(uctx, c.req.param('id'));
    const flags = { ...job.flags };
    delete (flags as Record<string, unknown>).possibleDuplicates;
    const [updated] = await ctx.db.update(jobs).set({ flags, updatedAt: ctx.now() }).where(eq(jobs.id, job.id)).returning();
    return c.json({ job: updated });
  });

  /** Décision et précisions de l'utilisateur après l'analyse (boucle de feedback). */
  r.post('/:id/review', sessionOnly, async (c) => {
    const input = await body(
      c,
      z.object({
        decision: z.enum(['pursue', 'reject', 'reanalyze', 'later']),
        skills: z.array(z.object({ name: z.string().trim().min(1).max(80), has: z.boolean(), level: z.string().max(80).optional(), context: z.string().max(600).optional() })).max(40).optional(),
        note: z.string().max(2000).optional(),
        noteScope: z.enum(['application', 'profile', 'style']).optional(),
        reason: z.string().max(500).optional(),
      }),
    );
    const job = await submitReview(c.get('uctx'), c.req.param('id'), input);
    deps.kick(c);
    return c.json({ job });
  });

  /** Lance (ou relance) l'analyse d'une offre, par exemple après l'avoir rétablie ou corrigée. */
  r.post('/:id/analyze', sessionOnly, async (c) => {
    const uctx = c.get('uctx');
    const job = await getJob(uctx, c.req.param('id'));
    if (isSubmitted(job.stage)) throw conflict('Une candidature est déjà partie pour cette offre.');
    if (['cv_in_progress', 'letter_in_progress', 'ready_to_apply', 'applying'].includes(job.stage)) throw conflict('Les documents de cette candidature sont déjà en préparation.');
    if (job.stage !== 'to_analyze') await setStage(uctx, job.id, 'to_analyze', { actor: 'user', reason: 'analyse demandée' });
    await enqueue(ctx.db, { type: job.qualifiedAt ? 'job.ats' : 'job.qualify', userId: uctx.userId, payload: { jobId: job.id, manual: true, force: true }, idempotencyKey: `${job.qualifiedAt ? 'job.ats' : 'job.qualify'}:${job.id}`, priority: 90, runAfter: ctx.now() });
    deps.kick(c);
    return c.json({ job: await getJob(uctx, job.id) });
  });

  /** Demande une nouvelle version du CV ou de la lettre, avec une consigne. La version précédente est conservée. */
  r.post('/:id/revise', sessionOnly, async (c) => {
    const uctx = c.get('uctx');
    const input = await body(c, z.object({ target: z.enum(['cv', 'letter']), instructions: z.string().trim().min(3).max(2000), scope: z.enum(['application', 'profile', 'style']).default('application') }));
    const job = await getJob(uctx, c.req.param('id'));
    if (!['letter_in_progress', 'ready_to_apply', 'cv_in_progress'].includes(job.stage)) throw conflict("Cette candidature n'est pas en cours de préparation.");
    await recordFeedback(uctx, job, { note: input.instructions, noteScope: input.scope });
    const to = input.target === 'cv' ? 'cv_in_progress' : 'letter_in_progress';
    const updated = await setStage(uctx, job.id, to, { actor: 'user', reason: `nouvelle version demandée : ${input.instructions.slice(0, 120)}` });
    const type = input.target === 'cv' ? 'job.tailor' : 'job.letter';
    await enqueue(ctx.db, { type, userId: uctx.userId, payload: { jobId: job.id }, idempotencyKey: `${type}:${job.id}`, priority: 88, runAfter: ctx.now() });
    deps.kick(c);
    return c.json({ job: updated });
  });

  r.delete('/:id', sessionOnly, async (c) => {
    const uctx = c.get('uctx');
    const job = await getJob(uctx, c.req.param('id'));
    if (isSubmitted(job.stage)) throw conflict("Une candidature est partie pour cette offre : elle fait partie de votre historique et ne peut pas être supprimée. Vous pouvez l'archiver.");
    await ctx.db.delete(jobs).where(eq(jobs.id, job.id));
    await logActivity(ctx.db, { userId: uctx.userId, actor: 'user', action: 'job.deleted', summary: `${job.companyName} — ${job.title}`, entityType: 'job', entityId: job.id });
    return c.json({ ok: true });
  });

  return r;
}
