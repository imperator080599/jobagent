// Sites carrières hébergés par les plateformes de recrutement. Chacune expose une
// API publique de lecture des offres d'une entreprise (celle qu'utilise son propre
// site carrières) : aucune authentification, aucune protection à contourner.
// Formes de réponse vérifiées sur les API réelles (novembre 2026).
import { z } from 'zod';
import type { UserContext } from '../../core/context.js';
import { fetchJson } from '../http.js';
import type { RawJob } from '../ingest.js';
import { type Connector, RequestBudget, type RunOutput } from './types.js';

const PAUSE = 600; // ms entre deux requêtes vers un même hôte
const slug = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/, 'Identifiant invalide');
const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

// ── Greenhouse ──

interface GhJob {
  id: number;
  title: string;
  absolute_url: string;
  updated_at?: string;
  first_published?: string;
  application_deadline?: string | null;
  requisition_id?: string | null;
  company_name?: string;
  location?: { name?: string };
  content?: string;
  departments?: { name: string }[];
  offices?: { name: string; location?: string | null }[];
}

export const greenhouse: Connector = {
  type: 'greenhouse',
  label: 'Greenhouse',
  mode: 'board',
  description: "Toutes les offres publiées par une entreprise sur son site carrières Greenhouse.",
  access: 'API publique « Job Board » de Greenhouse',
  fields: [
    { key: 'board', label: 'Identifiant du site carrières', placeholder: 'acme', hint: 'Le segment qui suit boards.greenhouse.io/ dans l\'adresse du site carrières.', required: true },
    { key: 'company', label: "Nom de l'entreprise", placeholder: 'Acme', required: true },
  ],
  configSchema: z.object({ board: slug, company: z.string().trim().min(1).max(120) }),
  detect(url) {
    if (!/(^|\.)greenhouse\.io$/.test(url.hostname)) return null;
    const board = url.searchParams.get('for') ?? url.pathname.split('/').filter(Boolean).find((s) => !['embed', 'job_board', 'jobs', 'v1', 'boards'].includes(s));
    return board ? { config: { board, company: board }, name: board } : null;
  },
  async run(ctx, { config, emit }) {
    const { board, company } = config as { board: string; company: string };
    const data = await fetchJson<{ jobs: GhJob[]; meta?: { total?: number } }>(ctx, `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=true`, { minIntervalMs: PAUSE, maxBytes: 40_000_000, timeoutMs: 45_000 });
    for (const j of data.jobs ?? []) {
      const ok = await emit({
        externalId: String(j.id),
        url: j.absolute_url,
        applyUrl: j.absolute_url,
        company: j.company_name || company,
        title: j.title,
        location: j.location?.name ?? j.offices?.[0]?.name ?? '',
        department: j.departments?.[0]?.name ?? '',
        // Le contenu est du HTML encodé en entités : il est décodé avant conversion en texte.
        descriptionHtml: j.content ? decode(j.content) : undefined,
        postedAt: j.first_published ?? j.updated_at ?? null,
        deadlineAt: j.application_deadline ?? null,
      });
      if (!ok) return { complete: false, incompleteReason: 'temps imparti écoulé', requests: 1, pages: 1, queries: [{ board }], reportedTotal: data.jobs.length };
    }
    // L'API rend toutes les offres en une seule réponse : la lecture est exhaustive.
    return { complete: true, requests: 1, pages: 1, queries: [{ board }], reportedTotal: data.meta?.total ?? data.jobs?.length ?? 0 };
  },
};

// ── Lever ──

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl?: string;
  createdAt?: number;
  country?: string;
  workplaceType?: string;
  categories?: { location?: string; team?: string; department?: string; commitment?: string; allLocations?: string[] };
  descriptionPlain?: string;
  description?: string;
  lists?: { text: string; content: string }[];
  additional?: string;
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
}

export const lever: Connector = {
  type: 'lever',
  label: 'Lever',
  mode: 'board',
  description: "Toutes les offres publiées par une entreprise sur son site carrières Lever.",
  access: 'API publique « Postings » de Lever',
  fields: [
    { key: 'site', label: 'Identifiant du site carrières', placeholder: 'acme', hint: 'Le segment qui suit jobs.lever.co/ dans l\'adresse.', required: true },
    { key: 'company', label: "Nom de l'entreprise", placeholder: 'Acme', required: true },
    { key: 'region', label: 'Région', placeholder: 'global ou eu', hint: 'eu pour un site jobs.eu.lever.co.' },
  ],
  configSchema: z.object({ site: slug, company: z.string().trim().min(1).max(120), region: z.enum(['global', 'eu']).default('global') }),
  detect(url) {
    if (!/^jobs\.(eu\.)?lever\.co$/.test(url.hostname)) return null;
    const site = url.pathname.split('/').filter(Boolean)[0];
    return site ? { config: { site, company: site, region: url.hostname.includes('.eu.') ? 'eu' : 'global' }, name: site } : null;
  },
  async run(ctx, { config, emit, maxRequests }) {
    const { site, company, region } = config as { site: string; company: string; region?: string };
    const base = region === 'eu' ? 'https://api.eu.lever.co' : 'https://api.lever.co';
    const budget = new RequestBudget(maxRequests);
    const limit = 100;
    let skip = 0;
    let pages = 0;
    for (;;) {
      if (!budget.take()) return { complete: false, incompleteReason: `plafond de ${maxRequests} requêtes atteint`, requests: budget.used, pages, queries: [{ site }] };
      const page = await fetchJson<LeverPosting[]>(ctx, `${base}/v0/postings/${encodeURIComponent(site)}?mode=json&skip=${skip}&limit=${limit}`, { minIntervalMs: PAUSE });
      pages++;
      for (const p of page) {
        const body = [p.description ?? '', ...(p.lists ?? []).map((l) => `<h3>${l.text}</h3><ul>${l.content}</ul>`), p.additional ?? ''].join('\n');
        const ok = await emit({
          externalId: p.id,
          url: p.hostedUrl,
          applyUrl: p.applyUrl ?? p.hostedUrl,
          company,
          title: p.text,
          location: p.categories?.allLocations?.join(' / ') || p.categories?.location || '',
          country: p.country ?? '',
          remote: p.workplaceType === 'remote' ? 'remote' : p.workplaceType === 'hybrid' ? 'hybrid' : p.workplaceType === 'on-site' || p.workplaceType === 'onsite' ? 'onsite' : '',
          contractType: p.categories?.commitment ?? '',
          department: p.categories?.department ?? p.categories?.team ?? '',
          descriptionHtml: body.trim() ? body : undefined,
          descriptionText: body.trim() ? undefined : p.descriptionPlain,
          postedAt: p.createdAt ? new Date(p.createdAt) : null,
          salary: p.salaryRange?.min || p.salaryRange?.max ? { min: p.salaryRange.min ?? null, max: p.salaryRange.max ?? null, currency: p.salaryRange.currency ?? '', period: /year/i.test(p.salaryRange.interval ?? '') ? 'year' : '' } : null,
        });
        if (!ok) return { complete: false, incompleteReason: 'temps imparti écoulé', requests: budget.used, pages, queries: [{ site }] };
      }
      if (page.length < limit) return { complete: true, requests: budget.used, pages, queries: [{ site }], reportedTotal: skip + page.length };
      skip += limit;
    }
  },
};

// ── Ashby ──

interface AshbyJob {
  id: string;
  title: string;
  location?: string;
  secondaryLocations?: { location?: string }[];
  department?: string;
  team?: string;
  employmentType?: string;
  isRemote?: boolean;
  workplaceType?: string;
  isListed?: boolean;
  publishedAt?: string;
  jobUrl: string;
  applyUrl?: string;
  descriptionHtml?: string;
  descriptionPlain?: string;
  address?: { postalAddress?: { addressCountry?: string; addressLocality?: string } };
}

const ASHBY_EMPLOYMENT: Record<string, string> = { FullTime: 'CDI', PartTime: '', Intern: 'Internship', Contract: 'Freelance', Temporary: 'Temporary' };

export const ashby: Connector = {
  type: 'ashby',
  label: 'Ashby',
  mode: 'board',
  description: "Toutes les offres publiées par une entreprise sur son site carrières Ashby.",
  access: 'API publique « Job Postings » d\'Ashby',
  fields: [
    { key: 'board', label: 'Identifiant du site carrières', placeholder: 'acme', hint: 'Le segment qui suit jobs.ashbyhq.com/ dans l\'adresse.', required: true },
    { key: 'company', label: "Nom de l'entreprise", placeholder: 'Acme', required: true },
  ],
  configSchema: z.object({ board: z.string().trim().min(1).max(80), company: z.string().trim().min(1).max(120) }),
  detect(url) {
    if (url.hostname !== 'jobs.ashbyhq.com') return null;
    const board = decodeURIComponent(url.pathname.split('/').filter(Boolean)[0] ?? '');
    return board ? { config: { board, company: board }, name: board } : null;
  },
  async run(ctx, { config, emit }) {
    const { board, company } = config as { board: string; company: string };
    const data = await fetchJson<{ jobs: AshbyJob[] }>(ctx, `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}?includeCompensation=true`, { minIntervalMs: PAUSE, maxBytes: 40_000_000, timeoutMs: 45_000 });
    const listed = (data.jobs ?? []).filter((j) => j.isListed !== false);
    for (const j of listed) {
      const ok = await emit({
        externalId: j.id,
        url: j.jobUrl,
        applyUrl: j.applyUrl ?? j.jobUrl,
        company,
        title: j.title,
        location: [j.location, ...(j.secondaryLocations ?? []).map((l) => l.location)].filter(Boolean).join(' / '),
        country: j.address?.postalAddress?.addressCountry ?? '',
        remote: j.workplaceType === 'Remote' || j.isRemote ? 'remote' : j.workplaceType === 'Hybrid' ? 'hybrid' : j.workplaceType === 'OnSite' ? 'onsite' : '',
        contractType: ASHBY_EMPLOYMENT[j.employmentType ?? ''] ?? '',
        department: j.department ?? j.team ?? '',
        descriptionHtml: j.descriptionHtml,
        descriptionText: j.descriptionHtml ? undefined : j.descriptionPlain,
        postedAt: j.publishedAt ?? null,
      });
      if (!ok) return { complete: false, incompleteReason: 'temps imparti écoulé', requests: 1, pages: 1, queries: [{ board }], reportedTotal: listed.length };
    }
    return { complete: true, requests: 1, pages: 1, queries: [{ board }], reportedTotal: listed.length };
  },
};

// ── SmartRecruiters ──

interface SrPosting {
  id: string;
  name: string;
  refNumber?: string;
  releasedDate?: string;
  ref?: string;
  company?: { identifier?: string; name?: string };
  location?: { city?: string; region?: string; country?: string; remote?: boolean; hybrid?: boolean; fullLocation?: string };
  department?: { label?: string };
  typeOfEmployment?: { id?: string; label?: string };
  experienceLevel?: { label?: string };
}
interface SrDetail {
  applyUrl?: string;
  postingUrl?: string;
  jobAd?: { sections?: Record<string, { title?: string; text?: string } | undefined> };
}

export const smartrecruiters: Connector = {
  type: 'smartrecruiters',
  label: 'SmartRecruiters',
  mode: 'board',
  description: "Toutes les offres publiées par une entreprise sur son site carrières SmartRecruiters. Le texte complet est chargé offre par offre, uniquement pour celles qui correspondent à vos recherches.",
  access: 'API publique « Posting » de SmartRecruiters',
  fields: [
    { key: 'company', label: "Identifiant de l'entreprise", placeholder: 'AcmeGroup', hint: 'Le segment qui suit jobs.smartrecruiters.com/ ou careers.smartrecruiters.com/ dans l\'adresse.', required: true },
    { key: 'name', label: "Nom de l'entreprise", placeholder: 'Acme', required: true },
  ],
  configSchema: z.object({ company: slug, name: z.string().trim().min(1).max(120) }),
  detect(url) {
    if (!/^(jobs|careers)\.smartrecruiters\.com$/.test(url.hostname)) return null;
    const company = url.pathname.split('/').filter(Boolean)[0];
    return company ? { config: { company, name: company }, name: company } : null;
  },
  async run(ctx, { config, emit, maxRequests }) {
    const { company, name } = config as { company: string; name: string };
    const budget = new RequestBudget(maxRequests);
    const limit = 100;
    let offset = 0;
    let pages = 0;
    let total: number | undefined;
    for (;;) {
      if (!budget.take()) return { complete: false, incompleteReason: `plafond de ${maxRequests} requêtes atteint`, requests: budget.used, pages, queries: [{ company }], reportedTotal: total };
      const page = await fetchJson<{ totalFound: number; content: SrPosting[] }>(ctx, `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings?limit=${limit}&offset=${offset}`, { minIntervalMs: PAUSE });
      pages++;
      total = page.totalFound;
      for (const p of page.content ?? []) {
        const loc = p.location ?? {};
        const ok = await emit({
          externalId: p.id,
          url: `https://jobs.smartrecruiters.com/${company}/${p.id}`,
          company: p.company?.name || name,
          title: p.name,
          location: loc.fullLocation || [loc.city, loc.region, loc.country?.toUpperCase()].filter(Boolean).join(', '),
          country: loc.country ?? '',
          remote: loc.remote ? 'remote' : loc.hybrid ? 'hybrid' : '',
          contractType: p.typeOfEmployment?.id === 'permanent' ? 'CDI' : (p.typeOfEmployment?.label ?? ''),
          department: p.department?.label ?? '',
          postedAt: p.releasedDate ?? null,
        });
        if (!ok) return { complete: false, incompleteReason: 'temps imparti écoulé', requests: budget.used, pages, queries: [{ company }], reportedTotal: total };
      }
      offset += limit;
      if ((page.content ?? []).length < limit || offset >= page.totalFound) return { complete: true, requests: budget.used, pages, queries: [{ company }], reportedTotal: total };
    }
  },
  async detail(ctx: UserContext, config, job: RawJob) {
    const { company } = config as { company: string };
    const d = await fetchJson<SrDetail>(ctx, `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings/${encodeURIComponent(job.externalId ?? '')}`, { minIntervalMs: PAUSE });
    const s = d.jobAd?.sections ?? {};
    const html = ['jobDescription', 'qualifications', 'additionalInformation'].map((k) => (s[k]?.text ? `<h3>${s[k]!.title ?? ''}</h3>${s[k]!.text}` : '')).join('\n');
    return { ...job, descriptionHtml: html.trim() || undefined, applyUrl: d.applyUrl ?? job.applyUrl, url: d.postingUrl ?? job.url };
  },
};

export type { RunOutput };
