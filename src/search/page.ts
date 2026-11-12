// Lecture d'une page d'offre : données structurées schema.org (JobPosting) d'abord,
// balises de la page ensuite. Aucune IA ici — les champs sont lus tels qu'ils sont
// publiés. Sert à l'ajout manuel par URL et aux sites carrières sans API.
import { parse as parseHtml } from 'node-html-parser';
import type { AppContext } from '../core/context.js';
import { allowedByRobots, FetchError, fetchText } from './http.js';
import type { RawJob } from './ingest.js';
import { htmlToText } from './normalize.js';

type J = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
const obj = (v: unknown): J | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : null);

function isType(node: J, type: string): boolean {
  return arr(node['@type']).some((t) => str(t).toLowerCase() === type.toLowerCase());
}

/** Parcourt un document JSON-LD (tableaux, @graph, objets imbriqués) à la recherche des JobPosting. */
export function findJobPostings(data: unknown, out: J[] = [], depth = 0): J[] {
  if (depth > 6 || data == null) return out;
  if (Array.isArray(data)) {
    for (const x of data) findJobPostings(x, out, depth + 1);
    return out;
  }
  const o = obj(data);
  if (!o) return out;
  if (isType(o, 'JobPosting')) out.push(o);
  if (o['@graph']) findJobPostings(o['@graph'], out, depth + 1);
  if (o.mainEntity) findJobPostings(o.mainEntity, out, depth + 1);
  if (o.itemListElement) for (const el of arr(o.itemListElement)) findJobPostings(obj(el)?.item ?? el, out, depth + 1);
  return out;
}

const EMPLOYMENT: Record<string, string> = { FULL_TIME: 'cdi', PART_TIME: '', CONTRACTOR: 'freelance', TEMPORARY: 'temp', INTERN: 'internship', VOLUNTEER: '', PER_DIEM: '', OTHER: '' };

function locationOf(node: J): { location: string; country: string } {
  const places = arr(node.jobLocation)
    .map(obj)
    .filter((p): p is J => Boolean(p));
  const parts: string[] = [];
  let country = '';
  for (const p of places.slice(0, 3)) {
    const a = obj(p.address) ?? p;
    const city = str(a.addressLocality);
    const region = str(a.addressRegion);
    const c = obj(a.addressCountry) ? str(obj(a.addressCountry)!.name) : str(a.addressCountry);
    if (!country && c) country = c;
    const label = [city, region && region !== city ? region : '', c].filter(Boolean).join(', ') || str(p.name);
    if (label && !parts.includes(label)) parts.push(label);
  }
  if (!parts.length) {
    const req = arr(node.applicantLocationRequirements).map(obj)[0];
    if (req) parts.push(str(req.name));
  }
  return { location: parts.join(' / '), country };
}

function salaryOf(node: J): RawJob['salary'] {
  const base = obj(node.baseSalary) ?? obj(node.estimatedSalary);
  if (!base) return null;
  const value = obj(base.value);
  const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() && !Number.isNaN(Number(v)) ? Number(v) : null);
  const min = num(value?.minValue) ?? num(value?.value) ?? num(base.value);
  const max = num(value?.maxValue) ?? num(value?.value) ?? num(base.value);
  if (min == null && max == null) return null;
  const unit = str(value?.unitText ?? base.unitText).toUpperCase();
  const period = unit.startsWith('YEAR') ? 'year' : unit.startsWith('MONTH') ? 'month' : unit.startsWith('DAY') ? 'day' : unit.startsWith('HOUR') ? 'hour' : '';
  return { min, max, currency: str(base.currency ?? value?.currency), period };
}

export function jobPostingToRaw(node: J, pageUrl: string): RawJob | null {
  const title = str(node.title) || str(node.name);
  const org = obj(node.hiringOrganization);
  const company = org ? str(org.name) : str(node.hiringOrganization);
  if (!title) return null;
  const { location, country } = locationOf(node);
  const remote = arr(node.jobLocationType).some((t) => str(t).toUpperCase() === 'TELECOMMUTE') ? 'remote' : '';
  const employment = arr(node.employmentType).map((t) => EMPLOYMENT[str(t).toUpperCase().replace(/[ -]/g, '_')] ?? '').find(Boolean) ?? '';
  const identifier = obj(node.identifier) ? str(obj(node.identifier)!.value) : str(node.identifier);
  const description = str(node.description);
  return {
    externalId: identifier || undefined,
    url: str(node.url) && /^https?:/.test(str(node.url)) ? str(node.url) : pageUrl,
    company,
    title,
    location,
    country,
    remote,
    contractType: employment,
    department: str(node.occupationalCategory) || str(node.industry),
    descriptionHtml: /<[a-z][^>]*>/i.test(description) ? description : undefined,
    descriptionText: /<[a-z][^>]*>/i.test(description) ? undefined : description,
    postedAt: str(node.datePosted) || null,
    deadlineAt: str(node.validThrough) || null,
    salary: salaryOf(node),
  };
}

export interface PageRead {
  job: RawJob | null;
  /** structured = données schema.org publiées par le site ; heuristic = déduit des balises de la page. */
  method: 'structured' | 'heuristic' | 'none';
  /** Texte principal de la page, pour une extraction assistée quand la structure manque. */
  pageText: string;
  pageTitle: string;
  siteName: string;
  /** La page signale que l'offre n'est plus ouverte. */
  closed: boolean;
}

const CLOSED = /(this (job|position|posting|role) (is|has been) (no longer|closed|filled|expired)|no longer (available|accepting applications)|position (has been )?filled|job (has )?expired|cette offre n'est plus (disponible|en ligne|d'actualité)|offre (expirée|pourvue|clôturée|archivée)|annonce (expirée|désactivée|n'est plus)|stelle (ist )?nicht mehr verfügbar|oferta (ya )?no (está )?disponible)/i;

export function readJobPage(html: string, pageUrl: string): PageRead {
  const root = parseHtml(html, { blockTextElements: { script: true, style: false, noscript: false } });
  const postings: J[] = [];
  for (const s of root.querySelectorAll('script[type="application/ld+json"]')) {
    const raw = s.text.trim();
    if (!raw) continue;
    try {
      findJobPostings(JSON.parse(raw), postings);
    } catch {
      try {
        // Certains sites laissent des retours à la ligne bruts dans les chaînes JSON.
        findJobPostings(JSON.parse(raw.replace(/[\u0000-\u001f]+/g, ' ')), postings);
      } catch {
        /* bloc illisible : ignoré */
      }
    }
  }
  const meta = (name: string) => root.querySelector(`meta[property="${name}"]`)?.getAttribute('content')?.trim() || root.querySelector(`meta[name="${name}"]`)?.getAttribute('content')?.trim() || '';
  const pageTitle = meta('og:title') || root.querySelector('title')?.text.trim() || '';
  const siteName = meta('og:site_name');
  root.querySelectorAll('script,style,noscript,nav,footer,header,form,svg,iframe').forEach((n) => n.remove());
  const main = root.querySelector('main') ?? root.querySelector('article') ?? root.querySelector('[role="main"]') ?? root.querySelector('body') ?? root;
  const pageText = htmlToText(main.innerHTML).slice(0, 60_000);
  const closed = CLOSED.test(pageText.slice(0, 3000));

  // Une page d'offre porte un seul JobPosting ; s'il y en a plusieurs (page de liste), aucun n'est retenu.
  if (postings.length === 1) {
    const job = jobPostingToRaw(postings[0]!, pageUrl);
    if (job) {
      if (!job.company) job.company = siteName;
      if (!job.descriptionHtml && !job.descriptionText) job.descriptionText = pageText;
      return { job, method: 'structured', pageText, pageTitle, siteName, closed };
    }
  }
  const h1 = root.querySelector('h1')?.text.replace(/\s+/g, ' ').trim() ?? '';
  if (h1 && pageText.length > 400) {
    return { job: { url: pageUrl, company: siteName, title: h1, descriptionText: pageText }, method: 'heuristic', pageText, pageTitle, siteName, closed };
  }
  return { job: null, method: 'none', pageText, pageTitle, siteName, closed };
}

/** Télécharge puis lit une page d'offre indiquée par l'utilisateur. Un refus du site n'est jamais contourné. */
export async function fetchJobPage(ctx: AppContext, url: string): Promise<PageRead & { finalUrl: string }> {
  if (!(await allowedByRobots(ctx, url))) {
    throw new FetchError("Le site interdit la lecture automatique de cette page (robots.txt). Collez le texte de l'offre à la place.", 0, 'robots');
  }
  const res = await fetchText(ctx, url, { accept: 'text/html,application/xhtml+xml', untrustedTarget: true, maxBytes: 5_000_000 });
  return { ...readJobPage(res.text, res.url), finalUrl: res.url };
}
