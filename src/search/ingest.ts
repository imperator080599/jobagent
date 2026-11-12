// Enregistrement des offres et détection des doublons.
// CHECK_EXISTING_JOB (`checkExistingJob`) est appelé avant toute opération qui
// pourrait créer une offre ou une candidature en double : ajout manuel, collecte
// automatique, import d'alerte email, préparation et envoi d'une candidature.
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { UserContext } from '../core/context.js';
import { logActivity } from '../core/activity.js';
import { textSimilarity, tokenSimilarity } from '../core/text.js';
import { newId } from '../db/ids.js';
import { applications, companies, jobSightings, jobs, sources, stageHistory } from '../db/schema.js';
import { isSubmitted, STAGE_LABELS, type Stage } from '../shared/stages.js';
import {
  canonicalUrl,
  companyKey,
  descriptionHash,
  detectContract,
  detectSeniority,
  extractYears,
  fingerprint,
  htmlToText,
  inferLocation,
  offerLanguage,
  parseLocation,
  titleKey,
} from './normalize.js';

export type Job = typeof jobs.$inferSelect;

/** Offre telle que la fournit une source, avant normalisation. */
export interface RawJob {
  /** Identifiant de l'offre sur la source (stable d'une collecte à l'autre). */
  externalId?: string;
  url?: string;
  applyUrl?: string;
  company: string;
  title: string;
  location?: string;
  country?: string;
  remote?: '' | 'onsite' | 'hybrid' | 'remote';
  contractType?: string;
  department?: string;
  descriptionHtml?: string;
  descriptionText?: string;
  postedAt?: Date | string | null;
  deadlineAt?: Date | string | null;
  salary?: { min?: number | null; max?: number | null; currency?: string; period?: string } | null;
}

export interface NormalizedJob {
  fingerprint: string;
  canonicalUrl: string;
  applyUrl: string;
  externalRef: string;
  companyName: string;
  companyNorm: string;
  title: string;
  titleNorm: string;
  locationRaw: string;
  country: string;
  city: string;
  remote: '' | 'onsite' | 'hybrid' | 'remote';
  contractType: string;
  seniority: string;
  yearsMin: number | null;
  yearsMax: number | null;
  department: string;
  language: string;
  postedAt: Date | null;
  deadlineAt: Date | null;
  descriptionText: string;
  descriptionHash: string;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string;
  salaryPeriod: string;
}

const clean = (s: string | undefined | null) => (s ?? '').replace(/\s+/g, ' ').trim();

function toDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function normalizeJob(raw: RawJob): NormalizedJob {
  const title = clean(raw.title);
  const companyName = clean(raw.company);
  const description = raw.descriptionText?.trim() ? htmlToText(raw.descriptionText) : htmlToText(raw.descriptionHtml ?? '');
  const locationRaw = clean(raw.location) || inferLocation(description);
  const loc = parseLocation(locationRaw, raw.country ?? '');
  const canon = canonicalUrl(raw.url ?? '');
  const years = extractYears(description);
  return {
    fingerprint: fingerprint(companyName, title, loc, locationRaw),
    canonicalUrl: canon.url,
    applyUrl: clean(raw.applyUrl) || clean(raw.url),
    externalRef: canon.ref,
    companyName,
    companyNorm: companyKey(companyName),
    title,
    titleNorm: titleKey(title, locationRaw),
    locationRaw,
    country: loc.country,
    city: loc.city,
    remote: raw.remote || loc.remote || (/\b(full remote|100 ?% remote|fully remote|télétravail complet)\b/i.test(description.slice(0, 3000)) ? 'remote' : ''),
    contractType: detectContract(title, description, raw.contractType ?? ''),
    seniority: detectSeniority(title),
    yearsMin: years.min,
    yearsMax: years.max,
    department: clean(raw.department),
    language: offerLanguage(title, description),
    postedAt: toDate(raw.postedAt),
    deadlineAt: toDate(raw.deadlineAt),
    descriptionText: description,
    descriptionHash: descriptionHash(description),
    salaryMin: raw.salary?.min ?? null,
    salaryMax: raw.salary?.max ?? null,
    salaryCurrency: raw.salary?.currency ?? '',
    salaryPeriod: raw.salary?.period ?? '',
  };
}

// ── CHECK_EXISTING_JOB ──

export type MatchKind = 'url' | 'reference' | 'fingerprint' | 'content' | 'similar';

export interface ExistingJobVerdict {
  /** Une offre identique est déjà connue : aucune nouvelle fiche ne doit être créée. */
  exists: boolean;
  job: Job | null;
  match: MatchKind | null;
  /** Une candidature est déjà partie pour cette offre : il est interdit de repostuler. */
  alreadyApplied: boolean;
  /** Une candidature est déjà en préparation ou en cours d'envoi. */
  inProgress: boolean;
  /** Résumé lisible de l'état connu (« Candidature envoyée le … »). */
  summary: string;
  /** Offres proches mais pas assez pour conclure : à montrer à l'utilisateur, jamais fusionnées d'office. */
  possible: { job: Job; similarity: number; reason: string }[];
}

type Probe = Pick<NormalizedJob, 'canonicalUrl' | 'externalRef' | 'fingerprint' | 'companyNorm' | 'titleNorm' | 'title' | 'city' | 'country' | 'descriptionText' | 'descriptionHash'>;

const samePlace = (a: { city: string; country: string }, b: { city: string; country: string }) => {
  if (a.city && b.city) return a.city.toLowerCase() === b.city.toLowerCase();
  if (a.country && b.country) return a.country === b.country;
  return true; // lieu inconnu d'un côté : ne permet pas d'exclure
};

const IN_PROGRESS: Stage[] = ['cv_in_progress', 'letter_in_progress', 'ready_to_apply', 'applying'];

function verdict(job: Job | null, match: MatchKind | null, possible: ExistingJobVerdict['possible'] = []): ExistingJobVerdict {
  if (!job) return { exists: false, job: null, match: null, alreadyApplied: false, inProgress: false, summary: '', possible };
  const alreadyApplied = isSubmitted(job.stage);
  const inProgress = IN_PROGRESS.includes(job.stage);
  const since = job.stageChangedAt.toISOString().slice(0, 10);
  const summary = alreadyApplied
    ? `Candidature déjà partie pour cette offre (${STAGE_LABELS[job.stage]}, depuis le ${since}).`
    : job.userDecision === 'rejected' || job.stage === 'abandoned'
      ? `Offre déjà connue et écartée le ${(job.userDecidedAt ?? job.stageChangedAt).toISOString().slice(0, 10)}.`
      : `Offre déjà connue (${STAGE_LABELS[job.stage]}).`;
  return { exists: true, job, match, alreadyApplied, inProgress, summary, possible };
}

/**
 * Cherche une offre déjà connue. Du plus sûr au moins sûr :
 * 1. même adresse canonique ; 2. même référence de plateforme ; 3. même empreinte
 * (entreprise + intitulé + lieu) ; 4. même entreprise et même texte ; 5. même
 * entreprise, intitulé très proche, lieu compatible et description très proche.
 * En dessous de ces seuils, l'offre n'est pas fusionnée mais signalée comme doublon possible.
 */
export async function checkExistingJob(ctx: UserContext, probe: Probe, opts: { excludeId?: string } = {}): Promise<ExistingJobVerdict> {
  const { db, userId } = ctx;
  const keep = (rows: Job[]) => rows.filter((r) => r.id !== opts.excludeId);
  // Une offre dont une candidature est déjà partie l'emporte toujours sur ses jumelles.
  const best = (rows: Job[]) => rows.sort((a, b) => Number(isSubmitted(b.stage)) - Number(isSubmitted(a.stage)) || a.createdAt.getTime() - b.createdAt.getTime())[0] ?? null;

  if (probe.canonicalUrl) {
    const hit = best(keep(await db.select().from(jobs).where(and(eq(jobs.userId, userId), eq(jobs.canonicalUrl, probe.canonicalUrl)))));
    if (hit) return verdict(hit, 'url');
  }
  if (probe.externalRef) {
    const hit = best(keep(await db.select().from(jobs).where(and(eq(jobs.userId, userId), eq(jobs.externalRef, probe.externalRef)))));
    if (hit) return verdict(hit, 'reference');
  }
  const sameCompany = keep(
    await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.userId, userId), or(eq(jobs.companyNorm, probe.companyNorm), eq(jobs.fingerprint, probe.fingerprint))))
      .orderBy(desc(jobs.lastSeenAt))
      .limit(400),
  );
  const fp = best(sameCompany.filter((j) => j.fingerprint === probe.fingerprint));
  if (fp) {
    // Même entreprise, même intitulé, même lieu : c'est la même offre, sauf si les deux
    // annonces portent des références de plateforme distinctes ET des textes différents
    // (deux postes identiques ouverts dans deux équipes).
    const distinctRefs = Boolean(probe.externalRef && fp.externalRef && probe.externalRef.split(':')[0] === fp.externalRef.split(':')[0] && probe.externalRef !== fp.externalRef);
    const differentText = Boolean(probe.descriptionText && fp.descriptionText) && textSimilarity(probe.descriptionText, fp.descriptionText) < 0.5;
    if (!(distinctRefs && differentText)) return verdict(fp, 'fingerprint');
  }
  if (probe.descriptionHash) {
    const same = best(sameCompany.filter((j) => j.descriptionHash === probe.descriptionHash && j.companyNorm === probe.companyNorm && samePlace(j, probe)));
    if (same) return verdict(same, 'content');
  }
  const possible: ExistingJobVerdict['possible'] = [];
  for (const j of sameCompany) {
    if (j.companyNorm !== probe.companyNorm || !samePlace(j, probe)) continue;
    const titleSim = j.titleNorm === probe.titleNorm ? 1 : tokenSimilarity(j.titleNorm, probe.titleNorm);
    if (titleSim < 0.5) continue;
    const bothText = Boolean(j.descriptionText && probe.descriptionText);
    const textSim = bothText ? textSimilarity(j.descriptionText, probe.descriptionText) : 0;
    if (titleSim >= 0.8 && bothText && textSim >= 0.7) return verdict(j, 'similar');
    if (titleSim >= 0.8 || (bothText && textSim >= 0.5)) {
      possible.push({ job: j, similarity: Math.round(Math.max(titleSim * 0.6 + textSim * 0.4, textSim) * 100) / 100, reason: bothText ? `intitulé proche à ${Math.round(titleSim * 100)} %, texte commun à ${Math.round(textSim * 100)} %` : `intitulé proche à ${Math.round(titleSim * 100)} %` });
    }
  }
  possible.sort((a, b) => b.similarity - a.similarity);
  return verdict(null, null, possible.slice(0, 5));
}

// ── Sources ──

export type Source = typeof sources.$inferSelect;

/** Source « Ajout manuel » de l'utilisateur (créée à la demande). */
export async function manualSource(ctx: UserContext): Promise<Source> {
  const [existing] = await ctx.db.select().from(sources).where(and(eq(sources.userId, ctx.userId), eq(sources.type, 'manual')));
  if (existing) return existing;
  const [created] = await ctx.db
    .insert(sources)
    .values({ id: newId('src'), userId: ctx.userId, type: 'manual', name: 'Ajout manuel', config: {}, intervalMinutes: 0, health: 'ok' })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [again] = await ctx.db.select().from(sources).where(and(eq(sources.userId, ctx.userId), eq(sources.type, 'manual')));
  return again!;
}

// ── Enregistrement ──

export interface IngestOptions {
  source: Source;
  runId?: string;
  actor?: string;
}

export interface IngestResult {
  job: Job;
  outcome: 'created' | 'updated' | 'duplicate';
  match: MatchKind | null;
  verdict: ExistingJobVerdict;
  /** L'annonce a été modifiée de façon notable depuis la dernière observation. */
  contentChanged: boolean;
}

/** Rattache l'offre à une entreprise suivie si elle existe (sans en créer). */
async function findCompanyId(ctx: UserContext, companyNorm: string): Promise<string | null> {
  if (!companyNorm) return null;
  const [co] = await ctx.db.select({ id: companies.id }).from(companies).where(and(eq(companies.userId, ctx.userId), eq(companies.nameNorm, companyNorm)));
  return co?.id ?? null;
}

async function recordSighting(ctx: UserContext, job: Job, n: NormalizedJob, raw: RawJob, o: IngestOptions): Promise<void> {
  // Ajout manuel : une seule observation par offre, quel que soit le nombre de saisies.
  const externalId = o.source.type === 'manual' ? job.id : raw.externalId || n.externalRef || n.canonicalUrl || n.fingerprint;
  const now = ctx.now();
  await ctx.db
    .insert(jobSightings)
    .values({ id: newId('sgt'), userId: ctx.userId, jobId: job.id, sourceId: o.source.id, externalId, url: raw.url ?? '', firstSeenAt: now, lastSeenAt: now, lastRunId: o.runId ?? '' })
    .onConflictDoUpdate({ target: [jobSightings.sourceId, jobSightings.externalId], set: { lastSeenAt: now, lastRunId: o.runId ?? '', goneAt: null, jobId: job.id, url: raw.url ?? '' } });
}

async function countSources(ctx: UserContext, jobId: string): Promise<number> {
  const [row] = await ctx.db
    .select({ n: sql<number>`count(distinct ${jobSightings.sourceId})::int` })
    .from(jobSightings)
    .where(and(eq(jobSightings.jobId, jobId), isNull(jobSightings.goneAt)));
  return Math.max(1, row?.n ?? 1);
}

/**
 * Enregistre une offre collectée. Si elle est déjà connue, la fiche existante est
 * complétée (nouvelle source, champs manquants, texte plus complet) et aucune fiche
 * n'est créée ; l'historique et les décisions déjà prises sont conservés.
 */
export async function ingestJob(ctx: UserContext, raw: RawJob, o: IngestOptions): Promise<IngestResult> {
  const n = normalizeJob(raw);
  if (!n.title || !n.companyName) throw new Error("Offre incomplète : l'intitulé et l'entreprise sont obligatoires.");
  const found = await checkExistingJob(ctx, n);
  const now = ctx.now();

  if (found.exists && found.job) {
    const cur = found.job;
    const patch: Partial<typeof jobs.$inferInsert> = { lastSeenAt: now, updatedAt: now };
    let contentChanged = false;
    if (!cur.canonicalUrl && n.canonicalUrl) {
      const [taken] = await ctx.db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.userId, ctx.userId), eq(jobs.canonicalUrl, n.canonicalUrl)));
      if (!taken) patch.canonicalUrl = n.canonicalUrl;
    }
    if (!cur.externalRef && n.externalRef) patch.externalRef = n.externalRef;
    if (!cur.applyUrl && n.applyUrl) patch.applyUrl = n.applyUrl;
    if (n.descriptionText && n.descriptionHash !== cur.descriptionHash) {
      const sim = cur.descriptionText ? textSimilarity(cur.descriptionText, n.descriptionText) : 0;
      // Le texte le plus complet est conservé ; un texte réellement différent est signalé.
      if (!cur.descriptionText || n.descriptionText.length > cur.descriptionText.length * 1.1 || (found.match !== 'similar' && found.match !== 'fingerprint' && sim < 0.9)) {
        patch.descriptionText = n.descriptionText;
        patch.descriptionHash = n.descriptionHash;
        patch.language = n.language || cur.language;
        if (cur.descriptionText && sim < 0.75) contentChanged = true;
      }
    }
    for (const key of ['country', 'city', 'remote', 'contractType', 'seniority', 'department', 'locationRaw', 'salaryCurrency', 'salaryPeriod'] as const) {
      if (!cur[key] && n[key]) (patch as Record<string, unknown>)[key] = n[key];
    }
    for (const key of ['yearsMin', 'yearsMax', 'postedAt', 'deadlineAt', 'salaryMin', 'salaryMax'] as const) {
      if (cur[key] == null && n[key] != null) (patch as Record<string, unknown>)[key] = n[key];
    }
    if (n.deadlineAt && cur.deadlineAt && n.deadlineAt.getTime() !== cur.deadlineAt.getTime()) patch.deadlineAt = n.deadlineAt;
    if (!cur.companyId) {
      const companyId = await findCompanyId(ctx, cur.companyNorm);
      if (companyId) patch.companyId = companyId;
    }
    if (contentChanged) patch.flags = { ...cur.flags, contentChangedAt: now.toISOString() };
    // Une offre revue en ligne n'est plus expirée.
    if (cur.expiredAt) patch.expiredAt = null;
    await recordSighting(ctx, cur, n, raw, o);
    patch.sourcesCount = await countSources(ctx, cur.id);
    const [updated] = await ctx.db.update(jobs).set(patch).where(eq(jobs.id, cur.id)).returning();
    const job = updated ?? cur;
    if (cur.stage === 'expired') {
      const { setStage } = await import('../tracker/stage.js');
      await setStage(ctx, cur.id, 'to_analyze', { actor: o.actor ?? 'system', reason: "L'offre est de nouveau en ligne", soft: true });
    }
    const changed = Object.keys(patch).some((k) => !['lastSeenAt', 'updatedAt', 'sourcesCount'].includes(k)) || patch.sourcesCount !== cur.sourcesCount;
    return { job, outcome: changed ? 'updated' : 'duplicate', match: found.match, verdict: found, contentChanged };
  }

  const id = newId('job');
  const inserted = await ctx.db
    .insert(jobs)
    .values({
      id,
      userId: ctx.userId,
      ...n,
      companyId: await findCompanyId(ctx, n.companyNorm),
      stage: 'new',
      stageChangedAt: now,
      flags: found.possible.length ? { possibleDuplicates: found.possible.map((p) => ({ id: p.job.id, similarity: p.similarity, reason: p.reason })) } : {},
      firstSeenAt: now,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (!inserted[0]) {
    // Deux collectes simultanées de la même annonce : la seconde rejoint la fiche créée par la première.
    const again = await checkExistingJob(ctx, n);
    if (!again.job) throw new Error("L'offre n'a pas pu être enregistrée.");
    await recordSighting(ctx, again.job, n, raw, o);
    return { job: again.job, outcome: 'duplicate', match: again.match, verdict: again, contentChanged: false };
  }
  const job = inserted[0];
  await recordSighting(ctx, job, n, raw, o);
  await ctx.db.insert(stageHistory).values({ id: newId('stg'), userId: ctx.userId, jobId: job.id, fromStage: '', toStage: 'new', actor: o.actor ?? 'system', reason: `Source : ${o.source.name}`, at: now });
  await logActivity(ctx.db, { userId: ctx.userId, actor: o.actor ?? 'system', action: 'job.created', summary: `${job.companyName} — ${job.title}`, entityType: 'job', entityId: job.id, data: { source: o.source.type } });
  return { job, outcome: 'created', match: null, verdict: found, contentChanged: false };
}

/** Fusionne une offre en double dans une autre (décision de l'utilisateur). Les observations sont transférées. */
export async function mergeJobs(ctx: UserContext, keepId: string, dropId: string): Promise<Job> {
  const rows = await ctx.db.select().from(jobs).where(and(eq(jobs.userId, ctx.userId), inArray(jobs.id, [keepId, dropId])));
  const keep = rows.find((r) => r.id === keepId);
  const drop = rows.find((r) => r.id === dropId);
  if (!keep || !drop || keepId === dropId) throw new Error('Offres introuvables.');
  const [app] = await ctx.db.select({ id: applications.id }).from(applications).where(and(eq(applications.userId, ctx.userId), eq(applications.jobId, dropId)));
  if (app || isSubmitted(drop.stage)) throw new Error("L'offre à fusionner porte déjà une candidature : conservez-la et fusionnez l'autre.");
  const sightings = await ctx.db.select().from(jobSightings).where(eq(jobSightings.jobId, dropId));
  for (const s of sightings) await ctx.db.update(jobSightings).set({ jobId: keepId }).where(eq(jobSightings.id, s.id));
  await ctx.db.delete(jobs).where(eq(jobs.id, dropId));
  const flags = { ...keep.flags };
  delete (flags as Record<string, unknown>).possibleDuplicates;
  const [updated] = await ctx.db
    .update(jobs)
    .set({ sourcesCount: await countSources(ctx, keepId), descriptionText: keep.descriptionText || drop.descriptionText, descriptionHash: keep.descriptionHash || drop.descriptionHash, applyUrl: keep.applyUrl || drop.applyUrl, flags, updatedAt: ctx.now() })
    .where(eq(jobs.id, keepId))
    .returning();
  await logActivity(ctx.db, { userId: ctx.userId, actor: 'user', action: 'job.merged', summary: `${drop.companyName} — ${drop.title} fusionnée`, entityType: 'job', entityId: keepId, data: { dropped: dropId } });
  return updated ?? keep;
}
