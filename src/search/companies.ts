// Annuaire des entreprises cibles et découverte de leurs sites carrières.
//
// Deux sens de recherche :
//  - descendant : chaque offre collectée (alerte, agrégateur, site) fait connaître son
//    entreprise ; si l'offre pointe vers un ATS (Greenhouse, Lever, Workday…), le site
//    carrières complet de l'entreprise est ajouté à la surveillance ;
//  - ascendant : les employeurs susceptibles de recruter (Big Four, conseil en
//    transactions, banques d'affaires, fonds…) sont surveillés directement, une fois leur
//    site carrières trouvé et vérifié.
// Découverte : page carrières indiquée (liens et cadres intégrés), puis interrogation des
// API publiques de lecture des ATS avec les identifiants plausibles de l'entreprise. Un
// site n'est retenu que si l'entreprise qu'il déclare correspond ; sinon il est « à confirmer ».
import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { UserContext } from '../core/context.js';
import { logActivity } from '../core/activity.js';
import { enqueue } from '../core/queue.js';
import { normalize, tokenSimilarity } from '../core/text.js';
import { newId } from '../db/ids.js';
import { companies, jobs, sources } from '../db/schema.js';
import { detectConnector, getConnector } from './connectors/index.js';
import { companyKey } from './normalize.js';
import { FetchError, fetchJson, fetchText } from './http.js';

export type Company = typeof companies.$inferSelect;

/**
 * Employeurs de départ pour les métiers visés (conseil en transactions, évaluation, M&A,
 * financement, private equity). Simples noms : leurs sites carrières sont découverts et
 * vérifiés en ligne, jamais supposés. Modifiable depuis Recherche → Entreprises.
 */
export const TARGET_SEED: { name: string; tags: string[] }[] = [
  ...['Deloitte', 'PwC', 'EY', 'KPMG'].map((name) => ({ name, tags: ['Big Four', 'Transaction Services'] })),
  ...['Alvarez & Marsal', 'FTI Consulting', 'BDO', 'Grant Thornton', 'Forvis Mazars', 'RSM', 'Kroll', 'Eight Advisory', 'Accuracy', 'Finexsi', 'Crowe', 'Baker Tilly', 'Oaklins', 'Ernst & Young Luxembourg'].map((name) => ({ name, tags: ['Conseil en transactions'] })),
  ...['Rothschild & Co', 'Lazard', 'Houlihan Lokey', 'Lincoln International', 'Clearwater International', 'DC Advisory', 'Natixis Partners', 'Oddo BHF', 'Evercore', 'Moelis & Company', 'PJT Partners', 'Jefferies', 'Alantra', 'Cambon Partners', 'Bryan, Garnier & Co', 'Edmond de Rothschild', 'Société Générale', 'BNP Paribas', 'Crédit Agricole CIB', 'Natixis'].map((name) => ({ name, tags: ['Banque d’affaires / M&A'] })),
  ...['Ardian', 'Eurazeo', 'PAI Partners', 'Tikehau Capital', 'Wendel', 'Apax Partners', 'Bridgepoint', 'CVC Capital Partners', 'EQT', 'KKR', 'Blackstone', 'Carlyle', 'Cinven', 'Permira', 'Astorg', 'Seven2', 'Andera Partners', 'Bpifrance', 'LBO France', 'Naxicap Partners', 'Siparex', 'Keensight Capital'].map((name) => ({ name, tags: ['Private equity'] })),
];

const LEGAL = /\b(sas|sasu|sa|sarl|llp|llc|ltd|limited|gmbh|ag|plc|inc|corp|group|groupe|holding|france|luxembourg|international|europe|co)\b/g;

/** Identifiants plausibles d'une entreprise sur un ATS (« Eight Advisory » → eightadvisory, eight-advisory…). */
export function slugCandidates(name: string): string[] {
  const base = normalize(name).replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').trim();
  const core = base.replace(LEGAL, ' ').replace(/\s+/g, ' ').trim() || base;
  const words = core.split(' ').filter(Boolean);
  const out = new Set<string>([words.join(''), words.join('-'), words.join('_'), base.replace(/\s+/g, ''), base.replace(/\s+/g, '-')]);
  if (words.length > 1) out.add(words[0]!);
  return [...out].filter((s) => s.length >= 2 && s.length <= 60);
}

const sameCompany = (a: string, b: string) => {
  const x = normalize(a).replace(LEGAL, ' ').replace(/[^a-z0-9 ]+/g, ' ').trim();
  const y = normalize(b).replace(LEGAL, ' ').replace(/[^a-z0-9 ]+/g, ' ').trim();
  return Boolean(x && y) && (x === y || tokenSimilarity(x, y) >= 0.75 || x.replace(/ /g, '') === y.replace(/ /g, ''));
};

export interface BoardHit {
  type: string;
  config: Record<string, unknown>;
  /** Nom de l'entreprise déclaré par le site carrières (s'il le donne). */
  declaredName: string | null;
  jobs: number | null;
  verified: boolean;
  via: string;
}

/** Interroge les API publiques de lecture des ATS avec un identifiant donné. Aucune écriture, aucune authentification. */
async function probe(ctx: UserContext, type: string, slug: string, name: string): Promise<BoardHit | null> {
  const s = encodeURIComponent(slug);
  try {
    switch (type) {
      case 'greenhouse': {
        const b = await fetchJson<{ name?: string }>(ctx, `https://boards-api.greenhouse.io/v1/boards/${s}`, { minIntervalMs: 400, timeoutMs: 15_000 });
        const jobs = await fetchJson<{ meta?: { total?: number } }>(ctx, `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`, { minIntervalMs: 400, timeoutMs: 15_000 });
        return { type, config: { board: slug, company: b.name || name }, declaredName: b.name ?? null, jobs: jobs.meta?.total ?? null, verified: Boolean(b.name && sameCompany(b.name, name)), via: 'API Greenhouse' };
      }
      case 'lever': {
        const list = await fetchJson<{ categories?: unknown }[]>(ctx, `https://api.lever.co/v0/postings/${s}?mode=json&limit=1`, { minIntervalMs: 400, timeoutMs: 15_000 });
        return Array.isArray(list) ? { type, config: { site: slug, company: name, region: 'global' }, declaredName: null, jobs: list.length ? null : 0, verified: false, via: 'API Lever' } : null;
      }
      case 'ashby': {
        const d = await fetchJson<{ jobs?: unknown[] }>(ctx, `https://api.ashbyhq.com/posting-api/job-board/${s}`, { minIntervalMs: 400, timeoutMs: 15_000 });
        return Array.isArray(d.jobs) ? { type, config: { board: slug, company: name }, declaredName: null, jobs: d.jobs.length, verified: false, via: 'API Ashby' } : null;
      }
      case 'smartrecruiters': {
        const d = await fetchJson<{ totalFound?: number; content?: { company?: { name?: string } }[] }>(ctx, `https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=1`, { minIntervalMs: 400, timeoutMs: 15_000 });
        const declared = d.content?.[0]?.company?.name ?? null;
        // SmartRecruiters répond même pour un identifiant inconnu : il faut une offre et un nom concordant.
        if (!d.totalFound || !declared) return null;
        return { type, config: { company: slug, name: declared }, declaredName: declared, jobs: d.totalFound, verified: sameCompany(declared, name), via: 'API SmartRecruiters' };
      }
      case 'personio': {
        const r = await fetchText(ctx, `https://${s}.jobs.personio.de/xml`, { minIntervalMs: 400, timeoutMs: 15_000 });
        if (!/<workzag-jobs/.test(r.text)) return null;
        return { type, config: { company: slug, name, domain: 'de' }, declaredName: null, jobs: (r.text.match(/<position>/g) ?? []).length, verified: false, via: 'flux Personio' };
      }
      case 'breezy': {
        const list = await fetchJson<{ company?: { name?: string } }[]>(ctx, `https://${s}.breezy.hr/json`, { minIntervalMs: 400, timeoutMs: 15_000 });
        if (!Array.isArray(list)) return null;
        const declared = list[0]?.company?.name ?? null;
        return { type, config: { company: slug, name: declared || name }, declaredName: declared, jobs: list.length, verified: Boolean(declared && sameCompany(declared, name)), via: 'flux Breezy' };
      }
      case 'recruitee': {
        const d = await fetchJson<{ offers?: unknown[] }>(ctx, `https://${s}.recruitee.com/api/offers/`, { minIntervalMs: 400, timeoutMs: 15_000 });
        return Array.isArray(d.offers) ? { type, config: { company: slug, name }, declaredName: null, jobs: d.offers.length, verified: false, via: 'API Recruitee' } : null;
      }
      default:
        return null;
    }
  } catch (err) {
    if (err instanceof FetchError) return null;
    throw err;
  }
}

const PROBE_TYPES = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'personio', 'breezy', 'recruitee'];

/** Liens vers un ATS trouvés sur la page carrières indiquée (liens, cadres intégrés, scripts d'intégration). */
async function fromCareersPage(ctx: UserContext, url: string): Promise<BoardHit | null> {
  try {
    const page = await fetchText(ctx, url, { untrustedTarget: true, minIntervalMs: 1000, timeoutMs: 20_000 });
    const candidates = [...page.text.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!).concat([...page.text.matchAll(/https?:\/\/[a-z0-9.-]+\.(?:greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|myworkdayjobs\.com|workable\.com|recruitee\.com|jobs\.personio\.(?:de|com)|breezy\.hr)[^"'\s<>)]*/gi)].map((m) => m[0]));
    for (const c of candidates) {
      let abs: string;
      try {
        abs = new URL(c, page.url).toString();
      } catch {
        continue;
      }
      const hit = detectConnector(abs);
      if (hit && hit.connector.mode === 'board') return { type: hit.connector.type, config: hit.config, declaredName: null, jobs: null, verified: true, via: `page carrières (${new URL(page.url).hostname})` };
    }
  } catch (err) {
    if (!(err instanceof FetchError)) throw err;
  }
  return null;
}

/** Ajoute (ou retrouve) la source de suivi du site carrières d'une entreprise. */
/** Champ portant le nom affiché de l'entreprise dans la configuration de chaque connecteur (l'autre étant l'identifiant). */
const DISPLAY_FIELD: Record<string, 'company' | 'name'> = { greenhouse: 'company', lever: 'company', ashby: 'company' };

export function withDisplayName(type: string, config: Record<string, unknown>, name: string): Record<string, unknown> {
  return { ...config, [DISPLAY_FIELD[type] ?? 'name']: name };
}

export async function ensureBoardSource(ctx: UserContext, company: Company, hit: { type: string; config: Record<string, unknown> }): Promise<string | null> {
  const connector = getConnector(hit.type);
  if (!connector) return null;
  const parsed = connector.configSchema.safeParse(withDisplayName(hit.type, hit.config, company.name));
  if (!parsed.success) return null;
  const existing = await ctx.db.select().from(sources).where(and(eq(sources.userId, ctx.userId), eq(sources.type, hit.type)));
  const idOf = (cfg: Record<string, unknown>) => JSON.stringify(Object.entries(cfg).filter(([k]) => k !== (DISPLAY_FIELD[hit.type] ?? 'name')).sort());
  const same = existing.find((s) => idOf(s.config as Record<string, unknown>) === idOf(parsed.data) || s.companyId === company.id);
  if (same) return same.id;
  const name = `${company.name} (${connector.label})`;
  const [row] = await ctx.db.insert(sources).values({ id: newId('src'), userId: ctx.userId, type: hit.type, name, config: parsed.data, companyId: company.id, intervalMinutes: 12 * 60 }).onConflictDoNothing().returning();
  if (!row) return null;
  await enqueue(ctx.db, { type: 'source.run', userId: ctx.userId, payload: { sourceId: row.id, trigger: 'manual' }, idempotencyKey: `source.run:${row.id}`, priority: 40, runAfter: ctx.now(), maxAttempts: 2 });
  await logActivity(ctx.db, { userId: ctx.userId, actor: 'agent:search', action: 'source.discovered', summary: `Site carrières suivi : ${name}`, entityType: 'source', entityId: row.id });
  return row.id;
}

/** Cherche, vérifie et met sous surveillance le site carrières d'une entreprise. */
export async function discoverCompany(ctx: UserContext, companyId: string): Promise<Company> {
  const [co] = await ctx.db.select().from(companies).where(and(eq(companies.id, companyId), eq(companies.userId, ctx.userId)));
  if (!co) throw new Error('Entreprise introuvable.');
  let hit: BoardHit | null = co.careersUrl ? (detectConnector(co.careersUrl)?.connector.mode === 'board' ? { ...(() => { const d = detectConnector(co.careersUrl)!; return { type: d.connector.type, config: d.config }; })(), declaredName: null, jobs: null, verified: true, via: 'adresse indiquée' } : await fromCareersPage(ctx, co.careersUrl)) : null;
  const tried: string[] = [];
  if (!hit) {
    const ambiguous: BoardHit[] = [];
    outer: for (const slug of slugCandidates(co.name).slice(0, 3)) {
      for (const type of PROBE_TYPES) {
        tried.push(`${type}:${slug}`);
        const h = await probe(ctx, type, slug, co.name);
        if (!h) continue;
        if (h.verified) {
          hit = h;
          break outer;
        }
        ambiguous.push(h);
      }
    }
    if (!hit && ambiguous.length) {
      const a = ambiguous[0]!;
      const note = `Site ${getConnector(a.type)?.label} « ${JSON.stringify(a.config)} » trouvé (${a.via}), mais l'entreprise qu'il déclare n'a pas pu être vérifiée${a.declaredName ? ` (« ${a.declaredName} »)` : ''} : à confirmer.`;
      const [row] = await ctx.db.update(companies).set({ discovery: 'ambiguous', discoveryNote: note, ats: a.type, atsConfig: a.config, lastCheckedAt: ctx.now() }).where(eq(companies.id, co.id)).returning();
      return row!;
    }
  }
  if (!hit) {
    const [row] = await ctx.db.update(companies).set({ discovery: 'not_found', discoveryNote: co.careersUrl ? "Aucun ATS reconnu sur la page carrières indiquée : elle sera relue comme page publique si vous l'ajoutez en flux." : `Aucun site carrières trouvé automatiquement (${tried.length} vérifications). Indiquez l'adresse de sa page carrières pour la suivre.`, lastCheckedAt: ctx.now() }).where(eq(companies.id, co.id)).returning();
    return row!;
  }
  const sourceId = await ensureBoardSource(ctx, co, hit);
  const [row] = await ctx.db.update(companies).set({ discovery: 'found', discoveryNote: `Trouvé via ${hit.via}${hit.jobs != null ? `, ${hit.jobs} offre(s) publiée(s)` : ''}.`, ats: hit.type, atsConfig: hit.config, boardSourceId: sourceId, lastCheckedAt: ctx.now() }).where(eq(companies.id, co.id)).returning();
  return row!;
}

/** Ajoute à l'annuaire les employeurs de départ (sans doublon). */
export async function seedTargetCompanies(ctx: UserContext): Promise<number> {
  let n = 0;
  for (const s of TARGET_SEED) {
    const [row] = await ctx.db.insert(companies).values({ id: newId('co'), userId: ctx.userId, name: s.name, nameNorm: companyKey(s.name), tier: 'target', tags: s.tags, origin: 'seed' }).onConflictDoNothing().returning();
    if (row) n++;
  }
  return n;
}

/**
 * Sens descendant : une offre collectée fait connaître son entreprise. Si elle pointe vers
 * un ATS, le site carrières complet est mis sous surveillance (entreprise ciblée, ou offre
 * pertinente selon vos recherches).
 */
export async function noteCompanyFromJob(ctx: UserContext, job: { id: string; companyId?: string | null; companyName: string; companyNorm: string; applyUrl: string; canonicalUrl: string; country: string }, opts: { relevant: boolean }): Promise<void> {
  if (!job.companyNorm) return;
  const [existing] = await ctx.db.select().from(companies).where(and(eq(companies.userId, ctx.userId), eq(companies.nameNorm, job.companyNorm)));
  const co =
    existing ??
    (await ctx.db
      .insert(companies)
      .values({ id: newId('co'), userId: ctx.userId, name: job.companyName, nameNorm: job.companyNorm, tier: 'watch', origin: 'job', countries: job.country ? [job.country] : [] })
      .onConflictDoNothing()
      .returning())[0];
  if (!co) return;
  // L'offre est rattachée à son entreprise dès sa création.
  if (!job.companyId) await ctx.db.update(jobs).set({ companyId: co.id }).where(and(eq(jobs.id, job.id), isNull(jobs.companyId)));
  const countries = job.country && !co.countries.includes(job.country) ? [...co.countries, job.country] : co.countries;
  await ctx.db.update(companies).set({ jobsSeen: sql`${companies.jobsSeen} + 1`, countries }).where(eq(companies.id, co.id));
  if (co.tier === 'excluded' || co.discovery === 'found') return;
  const url = [job.applyUrl, job.canonicalUrl].find((u) => u && detectConnector(u)?.connector.mode === 'board');
  if (url && (opts.relevant || co.tier === 'target' || co.tier === 'dream')) {
    const d = detectConnector(url)!;
    const sourceId = await ensureBoardSource(ctx, co, { type: d.connector.type, config: d.config });
    await ctx.db.update(companies).set({ discovery: 'found', discoveryNote: `Site ${d.connector.label} découvert par une offre.`, ats: d.connector.type, atsConfig: d.config, boardSourceId: sourceId, lastCheckedAt: ctx.now() }).where(eq(companies.id, co.id));
  }
}

/** Entreprises dont le site carrières reste à chercher (ou à revérifier). */
export async function companiesToDiscover(ctx: UserContext, limit: number): Promise<Company[]> {
  const stale = new Date(ctx.now().getTime() - 30 * 86400_000);
  return ctx.db
    .select()
    .from(companies)
    .where(and(eq(companies.userId, ctx.userId), inArray(companies.tier, ['dream', 'target']), or(eq(companies.discovery, 'unknown'), and(eq(companies.discovery, 'not_found'), or(isNull(companies.lastCheckedAt), lt(companies.lastCheckedAt, stale))))))
    .orderBy(asc(companies.lastCheckedAt))
    .limit(limit);
}
