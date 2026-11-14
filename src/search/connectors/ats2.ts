// Autres plateformes de sites carrières, lues par les flux publics qu'utilisent leurs
// propres pages carrières (aucune authentification, aucune protection contournée).
//  - Personio (flux XML) et Breezy HR (JSON) : formes vérifiées sur des sites réels (novembre 2026).
//  - Workable, Recruitee, Workday : implémentés d'après les points d'accès publics de leurs pages
//    carrières ; non vérifiés en conditions réelles depuis l'environnement de développement
//    (limitation de débit, hôte injoignable). La couverture ne les montre « opérationnels »
//    qu'après une première lecture réussie.
import { z } from 'zod';
import { fetchJson, fetchText } from '../http.js';
import { type Connector, RequestBudget } from './types.js';

const PAUSE = 800;
const slug = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/, 'Identifiant invalide');
const company = z.string().trim().min(1).max(120);

const tag = (block: string, name: string) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block);
  return m ? m[1]!.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : '';
};
const xmlDecode = (s: string) => s.replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// ── Personio ──

export const personio: Connector = {
  type: 'personio',
  label: 'Personio',
  mode: 'board',
  description: "Toutes les offres publiées par une entreprise sur son site carrières Personio, texte complet compris.",
  access: 'Flux XML public des offres Personio',
  fields: [
    { key: 'company', label: "Identifiant de l'entreprise", placeholder: 'acme', hint: "Le segment qui précède .jobs.personio.de dans l'adresse.", required: true },
    { key: 'name', label: "Nom de l'entreprise", placeholder: 'Acme', required: true },
    { key: 'domain', label: 'Domaine', placeholder: 'de ou com', hint: 'com pour un site en .jobs.personio.com.' },
  ],
  configSchema: z.object({ company: slug, name: company, domain: z.enum(['de', 'com']).default('de') }),
  detect(url) {
    const m = /^([a-z0-9-]+)\.jobs\.personio\.(de|com)$/.exec(url.hostname);
    return m ? { config: { company: m[1], name: m[1], domain: m[2] }, name: m[1]! } : null;
  },
  async run(ctx, { config, emit }) {
    const { company: c, name, domain } = config as { company: string; name: string; domain?: string };
    const base = `https://${c}.jobs.personio.${domain === 'com' ? 'com' : 'de'}`;
    const res = await fetchText(ctx, `${base}/xml`, { minIntervalMs: PAUSE, maxBytes: 30_000_000 });
    const blocks = res.text.match(/<position>[\s\S]*?<\/position>/g) ?? [];
    for (const b of blocks) {
      const id = tag(b, 'id');
      const sections = (b.match(/<jobDescription>[\s\S]*?<\/jobDescription>/g) ?? []).map((d) => `<h3>${xmlDecode(tag(d, 'name'))}</h3>${tag(d, 'value')}`);
      const ok = await emit({
        externalId: id,
        url: `${base}/job/${id}`,
        applyUrl: `${base}/job/${id}#apply`,
        company: name,
        title: xmlDecode(tag(b, 'name')),
        location: xmlDecode(tag(b, 'office')),
        department: xmlDecode(tag(b, 'department')),
        contractType: tag(b, 'employmentType') === 'permanent' ? 'CDI' : tag(b, 'employmentType'),
        descriptionHtml: sections.join('\n') || undefined,
        postedAt: tag(b, 'createdAt') || null,
      });
      if (!ok) return { complete: false, incompleteReason: 'temps imparti écoulé', requests: 1, pages: 1, queries: [{ company: c }], reportedTotal: blocks.length };
    }
    return { complete: true, requests: 1, pages: 1, queries: [{ company: c }], reportedTotal: blocks.length };
  },
};

// ── Breezy HR ──

interface BreezyJob {
  id: string;
  friendly_id: string;
  name: string;
  url: string;
  published_date?: string;
  type?: { id?: string; name?: string };
  location?: { name?: string; city?: string; country?: { id?: string; name?: string }; is_remote?: boolean };
  department?: string;
  company?: { name?: string };
}

export const breezy: Connector = {
  type: 'breezy',
  label: 'Breezy HR',
  mode: 'board',
  description: "Toutes les offres publiées par une entreprise sur son site carrières Breezy HR (texte complet lu sur la page de l'offre, au besoin).",
  access: 'Flux JSON public des offres Breezy HR',
  partialDescriptions: true,
  fields: [
    { key: 'company', label: "Identifiant de l'entreprise", placeholder: 'acme', hint: "Le segment qui précède .breezy.hr dans l'adresse.", required: true },
    { key: 'name', label: "Nom de l'entreprise", placeholder: 'Acme', required: true },
  ],
  configSchema: z.object({ company: slug, name: company }),
  detect(url) {
    const m = /^([a-z0-9-]+)\.breezy\.hr$/.exec(url.hostname);
    return m && m[1] !== 'app' ? { config: { company: m[1], name: m[1] }, name: m[1]! } : null;
  },
  async run(ctx, { config, emit }) {
    const { company: c, name } = config as { company: string; name: string };
    const list = await fetchJson<BreezyJob[]>(ctx, `https://${c}.breezy.hr/json`, { minIntervalMs: PAUSE });
    for (const j of list) {
      const ok = await emit({
        externalId: j.id,
        url: j.url,
        applyUrl: `${j.url.replace(/\/$/, '')}/apply`,
        company: j.company?.name || name,
        title: j.name,
        location: j.location?.name ?? '',
        country: j.location?.country?.id ?? '',
        remote: j.location?.is_remote ? 'remote' : '',
        contractType: j.type?.id === 'fullTime' ? 'CDI' : (j.type?.name ?? ''),
        department: j.department ?? '',
        postedAt: j.published_date ?? null,
      });
      if (!ok) return { complete: false, incompleteReason: 'temps imparti écoulé', requests: 1, pages: 1, queries: [{ company: c }], reportedTotal: list.length };
    }
    return { complete: true, requests: 1, pages: 1, queries: [{ company: c }], reportedTotal: list.length };
  },
};

// ── Workable ──

interface WorkableJob {
  title: string;
  shortcode: string;
  employment_type?: string;
  telecommuting?: boolean;
  department?: string;
  url?: string;
  shortlink?: string;
  application_url?: string;
  published_on?: string;
  created_at?: string;
  country?: string;
  city?: string;
  description?: string;
  locations?: { country?: string; countryCode?: string; city?: string; region?: string }[];
}

export const workable: Connector = {
  type: 'workable',
  label: 'Workable',
  mode: 'board',
  description: "Toutes les offres publiées par une entreprise sur son site carrières Workable.",
  access: 'Widget public des offres Workable (non vérifié en conditions réelles depuis cet environnement)',
  fields: [
    { key: 'account', label: "Identifiant de l'entreprise", placeholder: 'acme', hint: "Le segment qui suit apply.workable.com/ dans l'adresse.", required: true },
    { key: 'name', label: "Nom de l'entreprise", placeholder: 'Acme', required: true },
  ],
  configSchema: z.object({ account: slug, name: company }),
  detect(url) {
    if (url.hostname === 'apply.workable.com') {
      const account = url.pathname.split('/').filter(Boolean)[0];
      return account && account !== 'api' ? { config: { account, name: account }, name: account } : null;
    }
    const m = /^([a-z0-9-]+)\.workable\.com$/.exec(url.hostname);
    return m && !['www', 'apply', 'help', 'resources'].includes(m[1]!) ? { config: { account: m[1], name: m[1] }, name: m[1]! } : null;
  },
  async run(ctx, { config, emit }) {
    const { account, name } = config as { account: string; name: string };
    const data = await fetchJson<{ name?: string; jobs?: WorkableJob[] }>(ctx, `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(account)}?details=true`, { minIntervalMs: 1500 });
    const list = data.jobs ?? [];
    for (const j of list) {
      const loc = j.locations?.[0];
      const ok = await emit({
        externalId: j.shortcode,
        url: j.url || j.shortlink || `https://apply.workable.com/${account}/j/${j.shortcode}/`,
        applyUrl: j.application_url || `https://apply.workable.com/${account}/j/${j.shortcode}/apply/`,
        company: data.name || name,
        title: j.title,
        location: [loc?.city ?? j.city, loc?.region, loc?.country ?? j.country].filter(Boolean).join(', '),
        country: loc?.countryCode ?? '',
        remote: j.telecommuting ? 'remote' : '',
        contractType: j.employment_type === 'Full-time' ? 'CDI' : (j.employment_type ?? ''),
        department: j.department ?? '',
        descriptionHtml: j.description || undefined,
        postedAt: j.published_on ?? j.created_at ?? null,
      });
      if (!ok) return { complete: false, incompleteReason: 'temps imparti écoulé', requests: 1, pages: 1, queries: [{ account }], reportedTotal: list.length };
    }
    return { complete: true, requests: 1, pages: 1, queries: [{ account }], reportedTotal: list.length };
  },
};

// ── Recruitee ──

interface RecruiteeOffer {
  id: number;
  slug: string;
  title: string;
  description?: string;
  requirements?: string;
  location?: string;
  city?: string;
  country_code?: string;
  remote?: boolean;
  careers_url?: string;
  careers_apply_url?: string;
  published_at?: string;
  employment_type_code?: string;
  department?: string;
}

export const recruitee: Connector = {
  type: 'recruitee',
  label: 'Recruitee',
  mode: 'board',
  description: "Toutes les offres publiées par une entreprise sur son site carrières Recruitee.",
  access: 'API publique des sites carrières Recruitee (non vérifiée en conditions réelles depuis cet environnement)',
  fields: [
    { key: 'company', label: "Identifiant de l'entreprise", placeholder: 'acme', hint: "Le segment qui précède .recruitee.com dans l'adresse.", required: true },
    { key: 'name', label: "Nom de l'entreprise", placeholder: 'Acme', required: true },
  ],
  configSchema: z.object({ company: slug, name: company }),
  detect(url) {
    const m = /^([a-z0-9-]+)\.recruitee\.com$/.exec(url.hostname);
    return m && m[1] !== 'www' ? { config: { company: m[1], name: m[1] }, name: m[1]! } : null;
  },
  async run(ctx, { config, emit }) {
    const { company: c, name } = config as { company: string; name: string };
    const data = await fetchJson<{ offers?: RecruiteeOffer[] }>(ctx, `https://${c}.recruitee.com/api/offers/`, { minIntervalMs: PAUSE });
    const list = data.offers ?? [];
    for (const o of list) {
      const ok = await emit({
        externalId: String(o.id),
        url: o.careers_url ?? `https://${c}.recruitee.com/o/${o.slug}`,
        applyUrl: o.careers_apply_url ?? `https://${c}.recruitee.com/o/${o.slug}/c/new`,
        company: name,
        title: o.title,
        location: o.location ?? o.city ?? '',
        country: o.country_code ?? '',
        remote: o.remote ? 'remote' : '',
        contractType: o.employment_type_code === 'fulltime_permanent' ? 'CDI' : (o.employment_type_code ?? ''),
        department: o.department ?? '',
        descriptionHtml: [o.description, o.requirements].filter(Boolean).join('\n') || undefined,
        postedAt: o.published_at ?? null,
      });
      if (!ok) return { complete: false, incompleteReason: 'temps imparti écoulé', requests: 1, pages: 1, queries: [{ company: c }], reportedTotal: list.length };
    }
    return { complete: true, requests: 1, pages: 1, queries: [{ company: c }], reportedTotal: list.length };
  },
};

// ── Workday ──

interface WdPosting {
  title: string;
  externalPath: string;
  locationsText?: string;
  postedOn?: string;
  bulletFields?: string[];
}
interface WdDetail {
  jobPostingInfo?: { title?: string; jobDescription?: string; location?: string; externalUrl?: string; jobReqId?: string; startDate?: string; timeType?: string };
}

export const workday: Connector = {
  type: 'workday',
  label: 'Workday',
  mode: 'board',
  description: "Offres d'un site carrières Workday, recherchées avec vos intitulés visés et leurs synonymes ; texte complet chargé pour les offres retenues.",
  access: 'Points d’accès publics des pages carrières Workday (non vérifiés en conditions réelles depuis cet environnement)',
  partialDescriptions: true,
  fields: [
    { key: 'host', label: 'Adresse du site', placeholder: 'acme.wd3.myworkdayjobs.com', required: true },
    { key: 'tenant', label: 'Locataire', placeholder: 'acme', hint: "Le premier segment de l'adresse (avant .wd).", required: true },
    { key: 'site', label: 'Site carrières', placeholder: 'External', hint: "Le segment qui suit la langue dans l'adresse (ex. /en-US/External).", required: true },
    { key: 'name', label: "Nom de l'entreprise", placeholder: 'Acme', required: true },
  ],
  configSchema: z.object({ host: z.string().trim().regex(/^[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com$/i, 'Adresse Workday invalide'), tenant: slug, site: slug, name: company }),
  detect(url) {
    const m = /^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/i.exec(url.hostname);
    if (!m) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    const site = /^[a-z]{2}-[A-Z]{2}$/.test(parts[0] ?? '') ? parts[1] : parts[0];
    return site ? { config: { host: url.hostname, tenant: m[1], site, name: m[1] }, name: m[1]! } : null;
  },
  async run(ctx, { config, emit, terms, maxRequests }) {
    const { host, tenant, site, name } = config as { host: string; tenant: string; site: string; name: string };
    const api = `https://${host}/wday/cxs/${tenant}/${site}/jobs`;
    const budget = new RequestBudget(maxRequests);
    const seen = new Set<string>();
    let pages = 0;
    // Les grands sites Workday publient des milliers d'offres : la lecture est ciblée par vos intitulés.
    const queries = terms.length ? terms.slice(0, 12) : [''];
    for (const q of queries) {
      for (let offset = 0; offset < 200; offset += 20) {
        if (!budget.take()) return { complete: false, incompleteReason: `plafond de ${maxRequests} requêtes atteint`, requests: budget.used, pages, queries };
        const res = await fetchJson<{ total?: number; jobPostings?: WdPosting[] }>(ctx, api, { method: 'POST', body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: q }), headers: { 'content-type': 'application/json', accept: 'application/json' }, minIntervalMs: 1200 });
        pages++;
        const list = res.jobPostings ?? [];
        for (const p of list) {
          if (seen.has(p.externalPath)) continue;
          seen.add(p.externalPath);
          const ok = await emit({ externalId: p.bulletFields?.[0] ?? p.externalPath, url: `https://${host}/${site}${p.externalPath}`, applyUrl: `https://${host}/${site}${p.externalPath}/apply`, company: name, title: p.title, location: p.locationsText ?? '' });
          if (!ok) return { complete: false, incompleteReason: 'temps imparti écoulé', requests: budget.used, pages, queries };
        }
        if (list.length < 20 || offset + 20 >= (res.total ?? 0)) break;
      }
    }
    // Lecture filtrée par mots-clés : une offre absente n'est pas pour autant retirée.
    return { complete: !terms.length, incompleteReason: terms.length ? 'lecture ciblée par vos intitulés (site trop volumineux pour une lecture complète)' : undefined, requests: budget.used, pages, queries };
  },
  async detail(ctx, config, job) {
    const { host, tenant, site } = config as { host: string; tenant: string; site: string };
    const path = job.url?.split(`/${site}`)[1] ?? '';
    if (!path) return job;
    const d = await fetchJson<WdDetail>(ctx, `https://${host}/wday/cxs/${tenant}/${site}${path}`, { headers: { accept: 'application/json' }, minIntervalMs: 1200 });
    const info = d.jobPostingInfo ?? {};
    return { ...job, descriptionHtml: info.jobDescription || job.descriptionHtml, location: info.location || job.location, url: info.externalUrl || job.url, externalId: info.jobReqId || job.externalId };
  },
};
