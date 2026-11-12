// Moteurs d'offres interrogés par mots-clés, via leurs API officielles. Chacun
// exige des identifiants gratuits que l'utilisateur obtient lui-même et saisit dans
// l'interface. Écrits d'après la documentation publique de ces API et testés sur
// des réponses enregistrées ; ils n'ont pas pu être exercés en conditions réelles
// depuis l'environnement de développement (accès réseau restreint, pas d'identifiants).
import { z } from 'zod';
import { ConfigError } from '../../core/errors.js';
import { FetchError, fetchJson, fetchText } from '../http.js';
import { type Connector, RequestBudget } from './types.js';

// ── Flux RSS / Atom ──

const tag = (xml: string, name: string) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  if (!m) return '';
  const v = m[1]!.trim();
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(v);
  return (cdata ? cdata[1]! : v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')).trim();
};

export function parseFeed(xml: string): { title: string; link: string; description: string; date: string; id: string; location: string; company: string }[] {
  const items = [...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]!);
  return items.map((it) => {
    const atomLink = /<link[^>]*href="([^"]+)"[^>]*\/?>(?:<\/link>)?/i.exec(it)?.[1] ?? '';
    const link = tag(it, 'link') || atomLink;
    return {
      title: tag(it, 'title').replace(/<[^>]+>/g, '').trim(),
      link: link.trim(),
      description: tag(it, 'content:encoded') || tag(it, 'description') || tag(it, 'content') || tag(it, 'summary'),
      date: tag(it, 'pubDate') || tag(it, 'published') || tag(it, 'updated') || tag(it, 'dc:date'),
      id: tag(it, 'guid') || tag(it, 'id') || link,
      location: tag(it, 'location') || tag(it, 'job:location') || tag(it, 'tt:location') || tag(it, 'georss:featurename'),
      company: tag(it, 'company') || tag(it, 'job:company') || tag(it, 'dc:creator'),
    };
  });
}

export const feed: Connector = {
  type: 'feed',
  label: 'Flux RSS ou Atom',
  mode: 'feed',
  description: "Flux d'offres publié par un site carrières ou un site d'emploi (par exemple « /jobs.rss » sur les sites Teamtailor). Un flux ne contient que les offres les plus récentes : la couverture est partielle par nature.",
  access: 'Flux publié par le site',
  fields: [
    { key: 'url', label: 'Adresse du flux', placeholder: 'https://carrieres.exemple.com/jobs.rss', required: true },
    { key: 'company', label: "Nom de l'entreprise", hint: "À renseigner si le flux est celui d'une seule entreprise.", placeholder: 'Acme' },
  ],
  configSchema: z.object({ url: z.string().trim().url().max(2000), company: z.string().trim().max(120).default('') }),
  async run(ctx, { config, emit }) {
    const { url, company } = config as { url: string; company?: string };
    const res = await fetchText(ctx, url, { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml', untrustedTarget: true, minIntervalMs: 1000 });
    if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(res.text.slice(0, 2000))) throw new FetchError("Cette adresse ne renvoie pas un flux RSS ou Atom.", res.status, 'server');
    const items = parseFeed(res.text);
    for (const it of items) {
      if (!it.title || !it.link) continue;
      const ok = await emit({ externalId: it.id, url: it.link, company: company || it.company, title: it.title, location: it.location, descriptionHtml: it.description, postedAt: it.date || null });
      if (!ok) break;
    }
    // Un flux n'expose qu'une fenêtre glissante : l'absence d'une offre ne prouve pas son retrait.
    return { complete: false, incompleteReason: 'un flux ne publie que les offres les plus récentes', requests: 1, pages: 1, queries: [{ url }], reportedTotal: items.length };
  },
};

// ── France Travail (API « Offres d'emploi v2 ») ──

interface FtOffer {
  id: string;
  intitule: string;
  description?: string;
  dateCreation?: string;
  dateActualisation?: string;
  lieuTravail?: { libelle?: string; commune?: string };
  entreprise?: { nom?: string };
  typeContrat?: string;
  typeContratLibelle?: string;
  origineOffre?: { urlOrigine?: string; partenaires?: { url?: string }[] };
  salaire?: { libelle?: string };
}

const FT_CONTRACT: Record<string, string> = { CDI: 'CDI', CDD: 'CDD', MIS: 'Intérim', SAI: 'CDD', LIB: 'Freelance' };

export const francetravail: Connector = {
  type: 'francetravail',
  label: 'France Travail',
  mode: 'search',
  description: "Offres diffusées par France Travail et ses partenaires, en France. Une requête par intitulé visé ; toutes les pages sont lues jusqu'à la limite fixée par l'API (3 150 résultats par requête).",
  access: "API officielle « Offres d'emploi v2 » (francetravail.io), identifiants gratuits",
  fields: [
    { key: 'clientId', label: 'Identifiant client', hint: "Créez une application sur francetravail.io et abonnez-la à l'API « Offres d'emploi v2 ».", required: true },
    { key: 'departments', label: 'Départements', placeholder: '75, 92, 69', hint: 'Facultatif. Numéros séparés par des virgules ; vide = France entière.' },
    { key: 'maxDays', label: 'Ancienneté maximale (jours)', placeholder: '31', hint: '1, 3, 7, 14 ou 31.' },
  ],
  secrets: [{ key: 'francetravail_client_secret', label: 'Clé secrète', hint: "Affichée une seule fois lors de la création de l'application." }],
  configSchema: z.object({ clientId: z.string().trim().min(8).max(200), departments: z.string().trim().max(200).default(''), maxDays: z.coerce.number().int().refine((n) => [1, 3, 7, 14, 31].includes(n), 'Valeurs admises : 1, 3, 7, 14, 31').default(31) }),
  async run(ctx, { config, terms, secrets, emit, maxRequests }) {
    const { clientId, departments, maxDays } = config as { clientId: string; departments?: string; maxDays?: number };
    const secret = secrets.francetravail_client_secret;
    if (!secret) throw new ConfigError('La clé secrète France Travail est manquante (Recherche → Sources).', 'source_credentials');
    if (!terms.length) throw new ConfigError('Définissez au moins un intitulé visé (Recherche → Critères) pour interroger France Travail.', 'search_criteria');
    const budget = new RequestBudget(maxRequests);
    budget.take();
    const tokenRes = await fetchText(ctx, 'https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=%2Fpartenaire', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret, scope: 'api_offresdemploiv2 o2dsoffre' }).toString(),
    }).catch((err) => {
      if (err instanceof FetchError && (err.status === 400 || err.status === 401)) throw new ConfigError('France Travail refuse ces identifiants : vérifiez-les.', 'source_credentials');
      throw err;
    });
    const token = (JSON.parse(tokenRes.text) as { access_token?: string }).access_token;
    if (!token) throw new ConfigError("France Travail n'a pas délivré de jeton d'accès : vérifiez l'abonnement de votre application à l'API.", 'source_credentials');
    const deps = (departments ?? '').split(/[,; ]+/).filter(Boolean).slice(0, 5);
    const queries: unknown[] = [];
    let pages = 0;
    let complete = true;
    let reason = '';
    let reported = 0;
    outer: for (const term of terms) {
      queries.push({ motsCles: term, departement: deps.join(',') || undefined });
      for (let start = 0; start < 3150; start += 150) {
        if (!budget.take()) {
          complete = false;
          reason = `plafond de ${maxRequests} requêtes atteint`;
          break outer;
        }
        const params = new URLSearchParams({ motsCles: term, range: `${start}-${start + 149}`, publieeDepuis: String(maxDays ?? 31), sort: '1' });
        if (deps.length) params.set('departement', deps.join(','));
        const res = await fetchText(ctx, `https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search?${params}`, { headers: { authorization: `Bearer ${token}` }, accept: 'application/json', minIntervalMs: 350 });
        pages++;
        if (res.status === 204 || !res.text.trim()) break;
        const data = JSON.parse(res.text) as { resultats?: FtOffer[] };
        const total = Number(/\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '')?.[1] ?? 0);
        if (start === 0) reported += total;
        for (const o of data.resultats ?? []) {
          const ok = await emit({
            externalId: o.id,
            url: `https://candidat.francetravail.fr/offres/recherche/detail/${o.id}`,
            applyUrl: o.origineOffre?.partenaires?.[0]?.url || o.origineOffre?.urlOrigine,
            company: o.entreprise?.nom ?? '',
            title: o.intitule,
            location: (o.lieuTravail?.libelle ?? '').replace(/^\d{2,3}\s*-\s*/, ''),
            country: 'FR',
            contractType: FT_CONTRACT[o.typeContrat ?? ''] ?? o.typeContratLibelle ?? '',
            descriptionText: o.description,
            postedAt: o.dateCreation ?? null,
          });
          if (!ok) {
            complete = false;
            reason = 'temps imparti écoulé';
            break outer;
          }
        }
        if ((data.resultats ?? []).length < 150 || start + 150 >= total) break;
        if (start + 150 >= 3150) {
          complete = false;
          reason = `la requête « ${term} » dépasse les 3 150 résultats que l'API permet de parcourir`;
        }
      }
    }
    return { complete, incompleteReason: reason || undefined, requests: budget.used, pages, queries, reportedTotal: reported };
  },
};

// ── Adzuna ──

interface AdzunaResult {
  id: string;
  title: string;
  description?: string;
  created?: string;
  redirect_url: string;
  company?: { display_name?: string };
  location?: { display_name?: string };
  contract_type?: string;
  salary_min?: number;
  salary_max?: number;
  category?: { label?: string };
}

const ADZUNA_COUNTRIES = ['gb', 'us', 'at', 'au', 'be', 'br', 'ca', 'ch', 'de', 'es', 'fr', 'in', 'it', 'mx', 'nl', 'nz', 'pl', 'sg', 'za'];
const ADZUNA_CURRENCY: Record<string, string> = { gb: 'GBP', us: 'USD', ch: 'CHF', ca: 'CAD', au: 'AUD', sg: 'SGD', pl: 'PLN', in: 'INR', br: 'BRL', mx: 'MXN', nz: 'NZD', za: 'ZAR' };

export const adzuna: Connector = {
  type: 'adzuna',
  label: 'Adzuna',
  mode: 'search',
  partialDescriptions: true,
  description: "Agrégateur d'offres couvrant une vingtaine de pays (dont France, Royaume-Uni, Allemagne, Suisse, Belgique, Pays-Bas). Une requête par intitulé visé et par pays. L'API ne fournit qu'un extrait de chaque annonce : le texte complet est récupéré sur le site d'origine avant toute analyse ATS.",
  access: 'API officielle Adzuna (developer.adzuna.com), identifiants gratuits',
  fields: [
    { key: 'appId', label: "Identifiant d'application (app_id)", required: true },
    { key: 'countries', label: 'Pays', placeholder: 'fr, gb, ch', hint: `Codes séparés par des virgules. Pays couverts : ${ADZUNA_COUNTRIES.join(', ')}.`, required: true },
    { key: 'maxDays', label: 'Ancienneté maximale (jours)', placeholder: '30' },
  ],
  secrets: [{ key: 'adzuna_app_key', label: "Clé d'application (app_key)" }],
  configSchema: z.object({
    appId: z.string().trim().min(4).max(60),
    countries: z.string().trim().min(2).max(120).refine((v) => v.toLowerCase().split(/[,; ]+/).filter(Boolean).every((c) => ADZUNA_COUNTRIES.includes(c)), `Pays couverts : ${ADZUNA_COUNTRIES.join(', ')}`),
    maxDays: z.coerce.number().int().min(1).max(90).default(30),
  }),
  async run(ctx, { config, terms, secrets, emit, maxRequests }) {
    const { appId, countries, maxDays } = config as { appId: string; countries: string; maxDays?: number };
    const key = secrets.adzuna_app_key;
    if (!key) throw new ConfigError("La clé d'application Adzuna est manquante (Recherche → Sources).", 'source_credentials');
    if (!terms.length) throw new ConfigError('Définissez au moins un intitulé visé (Recherche → Critères) pour interroger Adzuna.', 'search_criteria');
    const budget = new RequestBudget(maxRequests);
    const perPage = 50;
    const queries: unknown[] = [];
    let pages = 0;
    let complete = true;
    let reason = '';
    let reported = 0;
    outer: for (const country of countries.toLowerCase().split(/[,; ]+/).filter(Boolean)) {
      for (const term of terms) {
        queries.push({ country, what: term });
        for (let page = 1; ; page++) {
          if (!budget.take()) {
            complete = false;
            reason = `plafond de ${maxRequests} requêtes atteint`;
            break outer;
          }
          const params = new URLSearchParams({ app_id: appId, app_key: key, results_per_page: String(perPage), what: term, max_days_old: String(maxDays ?? 30), sort_by: 'date', 'content-type': 'application/json' });
          const data = await fetchJson<{ count: number; results: AdzunaResult[] }>(ctx, `https://api.adzuna.com/v1/api/jobs/${country}/search/${page}?${params}`, { minIntervalMs: 1200 }).catch((err) => {
            if (err instanceof FetchError && (err.status === 401 || err.status === 403)) throw new ConfigError('Adzuna refuse ces identifiants : vérifiez-les.', 'source_credentials');
            throw err;
          });
          pages++;
          if (page === 1) reported += data.count ?? 0;
          for (const r of data.results ?? []) {
            const ok = await emit({
              externalId: `${country}:${r.id}`,
              url: r.redirect_url,
              company: r.company?.display_name ?? '',
              title: r.title.replace(/<\/?strong>/g, ''),
              location: r.location?.display_name ?? '',
              country: country.toUpperCase(),
              contractType: r.contract_type === 'permanent' ? 'CDI' : r.contract_type === 'contract' ? 'CDD' : '',
              department: r.category?.label ?? '',
              descriptionText: (r.description ?? '').replace(/<\/?strong>/g, ''),
              postedAt: r.created ?? null,
              salary: r.salary_min || r.salary_max ? { min: r.salary_min ?? null, max: r.salary_max ?? null, currency: ADZUNA_CURRENCY[country] ?? 'EUR', period: 'year' } : null,
            });
            if (!ok) {
              complete = false;
              reason = 'temps imparti écoulé';
              break outer;
            }
          }
          if ((data.results ?? []).length < perPage || page * perPage >= (data.count ?? 0)) break;
        }
      }
    }
    return { complete, incompleteReason: reason || undefined, requests: budget.used, pages, queries, reportedTotal: reported };
  },
};
