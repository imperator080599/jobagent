// Normalisation des offres : mêmes règles pour toutes les sources, afin qu'une offre
// diffusée sur plusieurs plateformes soit reconnue comme une seule et même offre.
// Tout est déterministe : aucune IA n'intervient dans l'identification d'une offre.
import { parse as parseHtml } from 'node-html-parser';
import { sha256 } from '../core/crypto.js';
import { detectLanguage, normalize } from '../core/text.js';

// ── URL canonique ──

const TRACKING = /^(utm_.*|gh_src|gh_jid_src|source|src|ref|refid|referer|referrer|trk|trackingid|lever-source.*|lever-origin|origin|gclid|fbclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|sid|cid|campaign|medium|from|shared|share|jobsource|iis|iisn|codes|rx_.*|bid|tk|advn|adid|vjs|position|pagenum|recommendedflavor|ebp|refId|eBP)$/i;

export interface CanonicalUrl {
  url: string;
  /** Identifiant de l'offre porté par l'URL, quand la plateforme est reconnue (ex. « gh:123 »). */
  ref: string;
}

export function canonicalUrl(input: string): CanonicalUrl {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return { url: '', ref: '' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { url: '', ref: '' };
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  let path = u.pathname.replace(/\/{2,}/g, '/');
  const q = new URLSearchParams();
  let ref = '';
  const seg = path.split('/').filter(Boolean);

  if (host.endsWith('greenhouse.io') && seg[1] === 'jobs' && seg[2]) {
    ref = `gh:${seg[2]}`;
    return { url: `https://job-boards.greenhouse.io/${seg[0]!.toLowerCase()}/jobs/${seg[2]}`, ref };
  }
  if (host === 'jobs.lever.co' && seg[1]) {
    ref = `lever:${seg[1]}`;
    return { url: `https://jobs.lever.co/${seg[0]!.toLowerCase()}/${seg[1]}`, ref };
  }
  if (host === 'jobs.ashbyhq.com' && seg[1]) {
    ref = `ashby:${seg[1]}`;
    return { url: `https://jobs.ashbyhq.com/${seg[0]}/${seg[1]}`, ref };
  }
  if (host === 'jobs.smartrecruiters.com' && seg[1]) {
    const id = /^(\d+)/.exec(seg[1])?.[1] ?? seg[1];
    ref = `sr:${id}`;
    return { url: `https://jobs.smartrecruiters.com/${seg[0]}/${id}`, ref };
  }
  // Les liens des emails LinkedIn passent par « /comm/jobs/view/… » : même offre, même adresse canonique.
  const li = host.endsWith('linkedin.com') && seg[0] === 'comm' ? seg.slice(1) : seg;
  if (host.endsWith('linkedin.com') && li[0] === 'jobs' && li[1] === 'view' && li[2]) {
    const id = /(\d{6,})\/?$/.exec(li[2])?.[1] ?? li[2];
    ref = `li:${id}`;
    return { url: `https://www.linkedin.com/jobs/view/${id}`, ref };
  }
  if (host.endsWith('indeed.com') && u.searchParams.get('jk')) {
    ref = `indeed:${u.searchParams.get('jk')}`;
    return { url: `https://${host}/viewjob?jk=${u.searchParams.get('jk')}`, ref };
  }
  if (host.endsWith('myworkdayjobs.com')) {
    // …/job/Paris/Senior-Associate_R-12345 : le numéro de réquisition suit le dernier « _ ».
    const last = seg[seg.length - 1] ?? '';
    const req = /_([A-Za-z0-9-]+)$/.exec(last)?.[1];
    if (req) ref = `wd:${host.split('.')[0]}:${req}`;
    path = `/${seg.filter((s) => !/^[a-z]{2}-[A-Z]{2}$/.test(s)).join('/')}`;
  }
  const ghJid = u.searchParams.get('gh_jid');
  if (ghJid) {
    ref = `gh:${ghJid}`;
    q.set('gh_jid', ghJid);
  }
  for (const [k, v] of [...u.searchParams.entries()].sort()) {
    if (k === 'gh_jid' || TRACKING.test(k) || v === '') continue;
    q.append(k, v);
  }
  path = path.replace(/\/(apply|application|postuler)\/?$/i, '').replace(/\/+$/, '');
  const qs = q.toString();
  return { url: `https://${host}${path}${qs ? `?${qs}` : ''}`, ref };
}

// ── Entreprise et intitulé ──

const LEGAL = /\b(sa|sas|sasu|sarl|ltd|limited|llp|llc|lp|inc|plc|gmbh|ag|bv|nv|spa|srl|s\.a\.|group|groupe|holding|holdings|and co|co|company|cie|corp|corporation)\b/g;
const COUNTRY_SUFFIX = /\b(france|uk|united kingdom|deutschland|germany|espana|spain|italia|italy|luxembourg|switzerland|suisse|belgium|belgique|netherlands|nederland|international|global|europe|emea)\b/g;

/** Clé d'entreprise : insensible à la casse, aux accents, à la forme juridique, au suffixe de pays et à « & / et / and ». */
export function companyKey(name: string): string {
  const pre = name
    .replace(/\bs\.?\s?[àa]\s?r\.?\s?l\.?(?=\s|$)/gi, ' sarl ')
    // Sigles ponctués : « S.A. » → « SA », « N.V. » → « NV ».
    .replace(/(?:\b[A-Za-z]\.){2,}/g, (m) => m.replace(/\./g, ''));
  const n = normalize(pre)
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const stripped = n.replace(LEGAL, ' ').replace(COUNTRY_SUFFIX, ' ').replace(/\s+/g, ' ').trim();
  return (stripped || n)
    .replace(/ (and|et|und|y|e) /g, ' & ')
    .replace(/\s*&\s*/g, '&')
    .replace(/^&+|&+$/g, '');
}

const TITLE_NOISE = [
  /\(\s*[hfmwdx]\s*[/|\\-]\s*[hfmwdx](\s*[/|\\-]\s*[hfmwdx])?\s*\)/gi, // (H/F), (m/w/d)
  /\b[hf]\s*\/\s*[hf]\b/gi,
  /\b(m\/w\/d|m\/f\/d|f\/m\/d|m\/f\/x|all genders?|tous genres)\b/gi,
  /\((cdi|cdd|v\.?i\.?e\.?|permanent|full[- ]time|temps plein|stage|internship|alternance)\)/gi,
  /\b(cdi|permanent contract|full[- ]time|temps plein)\b/gi,
  /\b(start(ing)?|d[ée]but|rentr[ée]e|à partir de|from)\s+(asap|d[èe]s que possible|[a-zéû]+\s+)?20\d{2}\b/gi,
  /\b(20\d{2})\b/g,
  /\b(new|nouveau|urgent|hiring)\b\s*[:!-]?/gi,
];

/** Intitulé normalisé : sans mention de genre, de contrat ni d'année, pour comparer d'une plateforme à l'autre. */
export function titleKey(title: string, location = ''): string {
  let t = ` ${title} `;
  for (const re of TITLE_NOISE) t = t.replace(re, ' ');
  let n = normalize(t).replace(/[^a-z0-9&+# ]/g, ' ').replace(/\s+/g, ' ').trim();
  // Lieu répété en fin d'intitulé (« … - Paris ») : il fait partie de la localisation, pas du poste.
  for (const part of normalize(location).split(/[^a-z]+/).filter((p) => p.length > 2)) {
    n = n.replace(new RegExp(`\\s+${part}$`), '');
  }
  return n.trim();
}

// ── Localisation ──

const COUNTRIES: Record<string, string[]> = {
  FR: ['france', 'francia', 'frankreich'],
  GB: ['united kingdom', 'uk', 'royaume uni', 'england', 'angleterre', 'great britain', 'scotland', 'ecosse', 'reino unido'],
  LU: ['luxembourg', 'luxemburg', 'luxemburgo'],
  CH: ['switzerland', 'suisse', 'schweiz', 'suiza'],
  BE: ['belgium', 'belgique', 'belgie', 'belgica'],
  DE: ['germany', 'allemagne', 'deutschland', 'alemania'],
  ES: ['spain', 'espagne', 'espana'],
  IT: ['italy', 'italie', 'italia'],
  NL: ['netherlands', 'pays bas', 'nederland', 'holland'],
  IE: ['ireland', 'irlande'],
  PT: ['portugal'],
  AT: ['austria', 'autriche', 'osterreich'],
  SE: ['sweden', 'suede'],
  DK: ['denmark', 'danemark'],
  NO: ['norway', 'norvege'],
  PL: ['poland', 'pologne'],
  US: ['united states', 'usa', 'etats unis', 'u s', 'estados unidos', 'united states of america'],
  CA: ['canada'],
  SG: ['singapore', 'singapour'],
  HK: ['hong kong'],
  AE: ['united arab emirates', 'uae', 'emirats arabes unis'],
  AU: ['australia', 'australie'],
  JP: ['japan', 'japon'],
  CN: ['china', 'chine'],
  IN: ['india', 'inde'],
  MA: ['morocco', 'maroc'],
  MX: ['mexico', 'mexique'],
  BR: ['brazil', 'bresil'],
  VN: ['vietnam', 'viet nam'],
  MY: ['malaysia', 'malaisie'],
  ZA: ['south africa', 'afrique du sud'],
};

const CITIES: Record<string, [string, string]> = {
  paris: ['Paris', 'FR'], 'la defense': ['Paris', 'FR'], 'paris la defense': ['Paris', 'FR'], 'neuilly sur seine': ['Paris', 'FR'], courbevoie: ['Paris', 'FR'], puteaux: ['Paris', 'FR'], 'levallois perret': ['Paris', 'FR'], 'boulogne billancourt': ['Paris', 'FR'], nanterre: ['Paris', 'FR'], 'ile de france': ['Paris', 'FR'],
  lyon: ['Lyon', 'FR'], marseille: ['Marseille', 'FR'], lille: ['Lille', 'FR'], bordeaux: ['Bordeaux', 'FR'], toulouse: ['Toulouse', 'FR'], nantes: ['Nantes', 'FR'], strasbourg: ['Strasbourg', 'FR'], nice: ['Nice', 'FR'], rennes: ['Rennes', 'FR'],
  london: ['London', 'GB'], londres: ['London', 'GB'], manchester: ['Manchester', 'GB'], birmingham: ['Birmingham', 'GB'], edinburgh: ['Edinburgh', 'GB'], leeds: ['Leeds', 'GB'], bristol: ['Bristol', 'GB'], glasgow: ['Glasgow', 'GB'],
  luxembourg: ['Luxembourg', 'LU'],
  geneva: ['Geneva', 'CH'], geneve: ['Geneva', 'CH'], zurich: ['Zurich', 'CH'], lausanne: ['Lausanne', 'CH'], basel: ['Basel', 'CH'],
  brussels: ['Brussels', 'BE'], bruxelles: ['Brussels', 'BE'], antwerp: ['Antwerp', 'BE'],
  frankfurt: ['Frankfurt', 'DE'], francfort: ['Frankfurt', 'DE'], 'frankfurt am main': ['Frankfurt', 'DE'], munich: ['Munich', 'DE'], munchen: ['Munich', 'DE'], berlin: ['Berlin', 'DE'], dusseldorf: ['Düsseldorf', 'DE'], hamburg: ['Hamburg', 'DE'], stuttgart: ['Stuttgart', 'DE'], cologne: ['Cologne', 'DE'],
  madrid: ['Madrid', 'ES'], barcelona: ['Barcelona', 'ES'], barcelone: ['Barcelona', 'ES'], valencia: ['Valencia', 'ES'], bilbao: ['Bilbao', 'ES'],
  milan: ['Milan', 'IT'], milano: ['Milan', 'IT'], rome: ['Rome', 'IT'], roma: ['Rome', 'IT'],
  amsterdam: ['Amsterdam', 'NL'], rotterdam: ['Rotterdam', 'NL'], dublin: ['Dublin', 'IE'], lisbon: ['Lisbon', 'PT'], lisbonne: ['Lisbon', 'PT'], vienna: ['Vienna', 'AT'], vienne: ['Vienna', 'AT'],
  stockholm: ['Stockholm', 'SE'], copenhagen: ['Copenhagen', 'DK'], oslo: ['Oslo', 'NO'], warsaw: ['Warsaw', 'PL'], varsovie: ['Warsaw', 'PL'],
  'new york': ['New York', 'US'], 'new york city': ['New York', 'US'], nyc: ['New York', 'US'], boston: ['Boston', 'US'], chicago: ['Chicago', 'US'], 'san francisco': ['San Francisco', 'US'], 'los angeles': ['Los Angeles', 'US'], houston: ['Houston', 'US'], miami: ['Miami', 'US'], washington: ['Washington', 'US'], dallas: ['Dallas', 'US'], atlanta: ['Atlanta', 'US'],
  toronto: ['Toronto', 'CA'], montreal: ['Montreal', 'CA'], vancouver: ['Vancouver', 'CA'],
  singapore: ['Singapore', 'SG'], singapour: ['Singapore', 'SG'], 'hong kong': ['Hong Kong', 'HK'], dubai: ['Dubai', 'AE'], 'abu dhabi': ['Abu Dhabi', 'AE'], sydney: ['Sydney', 'AU'], melbourne: ['Melbourne', 'AU'], tokyo: ['Tokyo', 'JP'], shanghai: ['Shanghai', 'CN'], mumbai: ['Mumbai', 'IN'], casablanca: ['Casablanca', 'MA'],
  'kuala lumpur': ['Kuala Lumpur', 'MY'], 'ho chi minh': ['Ho Chi Minh City', 'VN'], 'ho chi minh city': ['Ho Chi Minh City', 'VN'], hanoi: ['Hanoi', 'VN'], 'mexico city': ['Mexico City', 'MX'], 'sao paulo': ['São Paulo', 'BR'], johannesburg: ['Johannesburg', 'ZA'],
};

const COUNTRY_LOOKUP = new Map<string, string>();
for (const [code, names] of Object.entries(COUNTRIES)) for (const n of names) COUNTRY_LOOKUP.set(n, code);

export interface ParsedLocation {
  city: string;
  country: string;
  remote: '' | 'onsite' | 'hybrid' | 'remote';
}

/** Ville, pays (code ISO) et mode de travail extraits d'un libellé de localisation libre. */
export function parseLocation(raw: string, hintCountry = ''): ParsedLocation {
  const n = ` ${normalize(raw).replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ')} `;
  let remote: ParsedLocation['remote'] = '';
  if (/\b(hybrid|hybride|flex)\b/.test(n)) remote = 'hybrid';
  else if (/\b(remote|teletravail|full remote|home office|a distance|work from home)\b/.test(n)) remote = 'remote';
  let city = '';
  let country = /^[A-Za-z]{2}$/.test(hintCountry) ? hintCountry.toUpperCase() : (COUNTRY_LOOKUP.get(normalize(hintCountry)) ?? '');
  // La ville la plus longue l'emporte (« paris la defense » avant « paris »).
  for (const key of Object.keys(CITIES).sort((a, b) => b.length - a.length)) {
    if (n.includes(` ${key} `)) {
      city = CITIES[key]![0];
      if (!country) country = CITIES[key]![1];
      break;
    }
  }
  if (!country) {
    for (const [name, code] of [...COUNTRY_LOOKUP.entries()].sort((a, b) => b[0].length - a[0].length)) {
      if (name.length > 2 ? n.includes(` ${name} `) : new RegExp(`[,(/-]\\s*${name}\\s*\\)?\\s*$`, 'i').test(raw.trim())) {
        country = code;
        break;
      }
    }
  }
  if (!country) {
    const iso = /[,(]\s*([A-Z]{2})\s*\)?\s*$/.exec(raw.trim())?.[1];
    if (iso && COUNTRIES[iso]) country = iso;
  }
  if (!city) {
    // Ville inconnue du référentiel : premier segment du libellé, tel quel.
    const first = raw.split(/[,/|(–-]/)[0]?.trim() ?? '';
    if (first && first.length <= 40 && !COUNTRY_LOOKUP.has(normalize(first)) && !/remote|t[ée]l[ée]travail|hybrid/i.test(first)) city = first;
  }
  return { city, country, remote };
}

const LOCATION_CUE = /(?:bas[ée]e?s? (?:à|au|en|aux)|situ[ée]e?s? (?:à|au|en)|localis[ée]e?s? (?:à|au|en)|lieu(?: de travail)?\s*:|localisation\s*:|based in|located in|location\s*:|office in|standort\s*:|ubicaci[óo]n\s*:)\s+/giu;
// Nom de lieu : un à quatre mots commençant par une majuscule, éventuellement suivis de « , Pays ».
const PLACE_NAME = /^(\p{Lu}[\p{L}'’-]*(?:[ -]\p{Lu}[\p{L}'’-]*){0,3}(?:,[^\S\n]*\p{Lu}[\p{L}'’-]*(?:[ -]\p{Lu}[\p{L}'’-]*){0,2})?)/u;

/**
 * Lieu de travail lu dans le texte de l'annonce (« basé à Paris », « Location: London »)
 * lorsque la source n'en fournit pas. Seul un lieu reconnu du référentiel est retenu :
 * rien n'est deviné.
 */
export function inferLocation(text: string): string {
  const head = text.slice(0, 8000);
  const knownCity = (city: string) => Object.values(CITIES).some(([name]) => name === city);
  for (const cue of head.matchAll(LOCATION_CUE)) {
    const candidate = PLACE_NAME.exec(head.slice((cue.index ?? 0) + cue[0].length))?.[1]?.trim();
    if (!candidate) continue;
    const parsed = parseLocation(candidate);
    if (knownCity(parsed.city)) return candidate.includes(',') ? candidate : parsed.city;
    if (parsed.country && COUNTRY_LOOKUP.has(normalize(candidate))) return candidate;
  }
  return '';
}

// ── Contrat, séniorité, expérience ──

export type ContractType = '' | 'cdi' | 'cdd' | 'vie' | 'internship' | 'apprenticeship' | 'freelance' | 'temp' | 'graduate';

/** Type de contrat déduit de l'intitulé (prioritaire) puis du texte. Vide si rien ne l'indique. */
export function detectContract(title: string, description = '', hint = ''): ContractType {
  const t = ` ${normalize(`${title} ${hint}`)} `;
  const d = ` ${normalize(description.slice(0, 4000))} `;
  const test = (s: string, re: RegExp) => re.test(s);
  const INTERN = /\b(stage|stagiaire|intern|internship|interns|praktikum|praktikant|becario|practicas|summer analyst|off cycle|off-cycle|stage de fin d'etudes|pfe)\b/;
  const APPRENTICE = /\b(alternance|alternant|alternante|apprentissage|apprenti|apprentie|apprenticeship|apprentice|contrat pro|contrat de professionnalisation|work study|werkstudent)\b/;
  const VIE = /\b(v\.?i\.?e\.?|volontariat international|volontaire international|v\.?i\.?a\.?)\b/;
  if (test(t, VIE) || /\bvolontariat international en entreprise\b/.test(d)) return 'vie';
  if (test(t, APPRENTICE)) return 'apprenticeship';
  if (test(t, INTERN)) return 'internship';
  if (/\b(freelance|independant|contractor|portage salarial)\b/.test(t)) return 'freelance';
  if (/\b(interim|interimaire|temp|temporary|temporaire)\b/.test(t)) return 'temp';
  if (/\b(cdd|fixed term|fixed-term|duree determinee|contrat a duree determinee|befristet)\b/.test(t)) return 'cdd';
  if (/\b(graduate program|graduate programme|graduate scheme)\b/.test(t)) return 'graduate';
  if (/\b(cdi|permanent|duree indeterminee|unbefristet|full time|full-time|temps plein|festanstellung|indefinido)\b/.test(t)) return 'cdi';
  // À défaut d'indication dans l'intitulé, le début de la description fait foi.
  const head = d.slice(0, 1500);
  if (/\b(type de contrat|contract type|contrat)\s*:?\s*(stage|internship)\b/.test(head) || /\b(stage de \d+ mois|\d+ month internship|6 month internship|internship of)\b/.test(head)) return 'internship';
  if (/\b(type de contrat|contrat)\s*:?\s*(alternance|apprentissage)\b/.test(head)) return 'apprenticeship';
  if (/\b(cdi|contrat a duree indeterminee|permanent contract|permanent position|permanent role|unbefristet)\b/.test(d) || /\b(contract|contrat|employment type|type d'emploi)\s*:?\s*permanent\b/.test(head) || /\bpermanent,? full[- ]time\b/.test(head)) return 'cdi';
  if (/\b(cdd|contrat a duree determinee|fixed term contract)\b/.test(head)) return 'cdd';
  return '';
}

export type Seniority = '' | 'intern' | 'junior' | 'mid' | 'senior' | 'manager' | 'director';

export function detectSeniority(title: string): Seniority {
  const t = ` ${normalize(title)} `;
  if (/\b(stage|stagiaire|intern|internship|alternance|alternant|apprenti|apprentice|praktikum|summer analyst)\b/.test(t)) return 'intern';
  if (/\b(partner|associe gerant|managing director|md|directeur general|directrice generale|chief|cfo|head of|vice president|vp|principal)\b/.test(t)) return 'director';
  if (/\b(director|directeur|directrice|executive director|associate director)\b/.test(t)) return 'director';
  if (/\b(senior manager|manager senior|assistant manager|manager|responsable|chef de mission|engagement manager|team lead|lead)\b/.test(t)) return /\bassistant manager\b/.test(t) ? 'senior' : 'manager';
  if (/\b(senior|confirme|confirmee|experimente|experimentee|experienced|senior associate|senior consultant|senior analyst|sr)\b/.test(t)) return 'senior';
  if (/\b(junior|debutant|debutante|graduate|entry level|analyst i|analyste junior|jeune diplome)\b/.test(t)) return 'junior';
  if (/\b(analyst|analyste|associate|consultant|consultante|auditeur|auditrice|charge|chargee|collaborateur|collaboratrice|executive)\b/.test(t)) return 'mid';
  return '';
}

/** Années d'expérience demandées, lues dans la description (« 3 à 5 ans », « at least 2 years »). */
export function extractYears(description: string): { min: number | null; max: number | null } {
  const d = normalize(description).replace(/\s+/g, ' ');
  const unit = "(?:ans|an|annees|years|year|yrs|jahre|anos)";
  const num = '(\\d{1,2}(?:[.,]\\d)?)';
  let m = new RegExp(`${num}\\s*(?:a|-|to|–|et|and|bis)\\s*${num}\\s*\\+?\\s*${unit}`).exec(d);
  if (m) return { min: parseFloat(m[1]!.replace(',', '.')), max: parseFloat(m[2]!.replace(',', '.')) };
  m = new RegExp(`(?:minimum|min|at least|au moins|au minimum|mindestens|plus de|more than|over)\\s*(?:de |of )?${num}\\s*\\+?\\s*${unit}`).exec(d);
  if (m) return { min: parseFloat(m[1]!.replace(',', '.')), max: null };
  m = new RegExp(`${num}\\s*\\+\\s*${unit}`).exec(d);
  if (m) return { min: parseFloat(m[1]!.replace(',', '.')), max: null };
  m = new RegExp(`${num}\\s*${unit}\\s*(?:d'|de |of |d )?(?:experience|experiences|relevant|professional|post)`).exec(d);
  if (m) return { min: parseFloat(m[1]!.replace(',', '.')), max: null };
  m = new RegExp(`(?:experience|experiences)\\s*(?:de|of|:)?\\s*${num}\\s*${unit}`).exec(d);
  if (m) return { min: parseFloat(m[1]!.replace(',', '.')), max: null };
  return { min: null, max: null };
}

// ── Texte de l'offre ──

/** HTML d'une offre → texte lisible (paragraphes et listes conservés). Les scripts et styles sont écartés. */
export function htmlToText(html: string): string {
  if (!/<[a-z!/]/i.test(html)) return decodeEntities(html).replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const root = parseHtml(html, { blockTextElements: { script: false, style: false, noscript: false } });
  root.querySelectorAll('script,style,noscript,iframe,svg').forEach((n) => n.remove());
  let out = '';
  const BLOCK = new Set(['p', 'div', 'section', 'article', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'tr', 'header', 'footer', 'blockquote']);
  const walk = (node: any) => {
    if (node.nodeType === 3) {
      out += node.text.replace(/\s+/g, ' ');
      return;
    }
    const tag = (node.rawTagName ?? '').toLowerCase();
    if (tag === 'br') {
      out += '\n';
      return;
    }
    if (tag === 'li') out += '\n- ';
    else if (BLOCK.has(tag)) out += '\n\n';
    for (const child of node.childNodes ?? []) walk(child);
    if (/^h[1-6]$/.test(tag)) out += '\n';
    else if (BLOCK.has(tag)) out += '\n\n';
  };
  walk(root);
  return out
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeEntities(s: string): string {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}

// ── Empreinte ──

/** Empreinte d'une offre : entreprise + intitulé + ville (ou pays). Deux diffusions de la même offre ont la même empreinte. */
export function fingerprint(company: string, title: string, loc: ParsedLocation, locationRaw = ''): string {
  const place = normalize(loc.city || loc.country || locationRaw);
  return sha256(`${companyKey(company)}|${titleKey(title, locationRaw)}|${place}`).slice(0, 32);
}

export function descriptionHash(text: string): string {
  const n = normalize(text).replace(/\s+/g, ' ');
  return n ? sha256(n).slice(0, 32) : '';
}

export function offerLanguage(title: string, description: string): string {
  return detectLanguage(description) || detectLanguage(title);
}
