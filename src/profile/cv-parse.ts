// Analyse d'un CV par règles (sans IA). Sert de secours lorsqu'aucun modèle n'est
// disponible, et de simulation dans les tests. Le résultat est un brouillon que
// l'utilisateur relit et corrige avant validation : rien n'est déduit ni inventé,
// chaque valeur est un extrait du texte source.
import { normalize } from '../core/text.js';
import { type CvData, assignIds, emptyCv } from '../shared/cv.js';
import { extractDateRange, parsePartialDate } from './dates.js';

type SectionKey = 'summary' | 'experiences' | 'education' | 'skills' | 'languages' | 'certifications' | 'extras';

const HEADINGS: Record<SectionKey, string[]> = {
  summary: ['profil', 'profile', 'summary', 'professional summary', 'resume', 'a propos', 'about', 'about me', 'objectif', 'objective', 'presentation', 'perfil'],
  experiences: [
    'experience', 'experiences', 'experiences professionnelles', 'experience professionnelle', 'professional experience', 'work experience',
    'parcours professionnel', 'employment', 'employment history', 'experiencia', 'experiencia profesional', 'berufserfahrung',
  ],
  education: ['formation', 'formations', 'education', 'etudes', 'diplomes', 'formation academique', 'academic background', 'educacion', 'formacion', 'ausbildung', 'cursus'],
  skills: ['competences', 'skills', 'competences techniques', 'technical skills', 'outils', 'hard skills', 'expertise', 'competences cles', 'key skills', 'habilidades', 'informatique'],
  languages: ['langues', 'languages', 'idiomas', 'sprachen', 'langues etrangeres'],
  certifications: ['certifications', 'certificats', 'certificates', 'licenses and certifications', 'diplomes et certifications', 'certificaciones'],
  extras: [
    'centres d\'interet', 'centres d interet', 'interets', 'interests', 'activites', 'activites extra professionnelles', 'loisirs', 'engagements',
    'engagement associatif', 'vie associative', 'volunteering', 'benevolat', 'projets', 'projects', 'distinctions', 'publications', 'hobbies', 'divers', 'autres',
    'extra curricular activities', 'additional information', 'informations complementaires',
  ],
};

const HEADING_LOOKUP = new Map<string, SectionKey>();
for (const [key, names] of Object.entries(HEADINGS) as [SectionKey, string[]][]) for (const n of names) HEADING_LOOKUP.set(n, key);

const BULLET_RE = /^\s*(?:[•◦▪■●○·‣∙➢➤►▸✓✔*>-]|–|—|\d{1,2}[.)])\s+/;

const TITLE_WORDS =
  /\b(auditeur|auditrice|auditor|analyst[e]?|consultant[e]?|manager|stagiaire|stage|intern|internship|assistant[e]?|associate|senior|junior|ingenieur[e]?|engineer|charge[e]? de|responsable|directeur|directrice|director|controleur|controleuse|controller|comptable|accountant|chef de|head of|lead|developer|developpeur|officer|specialist[e]?|alternant[e]?|apprenti[e]?|vp|vice president|partner|associe[e]?|trader|banker|gestionnaire|coordinat(?:eur|rice|or)|collaborat(?:eur|rice))\b/;
const DEGREE_WORDS =
  /\b(master|mastere|msc|m\.sc|mba|licence|bachelor|bsc|ba|bba|phd|doctorat|diplome|programme|program|grande ecole|classe preparatoire|classes preparatoires|prepa|baccalaureat|bac|dut|bts|degree|certificate|dscg|dcg|cpa|cfa|exchange|echange|semestre|specialisation|specialization|grado|licenciatura)\b/;
const LOCATION_HINT =
  /\b(france|paris|lyon|marseille|la defense|londres|london|united kingdom|uk|luxembourg|geneve|geneva|zurich|suisse|switzerland|bruxelles|brussels|belgique|belgium|madrid|barcelone|barcelona|espagne|spain|berlin|francfort|frankfurt|allemagne|germany|new york|usa|etats unis|united states|canada|montreal|toronto|singapour|singapore|hong kong|dubai|milan|italie|italy|amsterdam|pays bas|netherlands|dublin|irlande|ireland|lisbonne|lisbon|portugal|remote|teletravail)\b/;

function isHeading(line: string): SectionKey | null {
  const raw = line.trim().replace(/[:：]\s*$/, '');
  if (!raw || raw.length > 48 || BULLET_RE.test(raw)) return null;
  const n = normalize(raw).replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').trim();
  return HEADING_LOOKUP.get(n) ?? null;
}

/**
 * Recolle les lignes coupées par la mise en page (retours à la ligne d'un PDF).
 * Une ligne est considérée comme coupée si elle atteint la largeur de texte du
 * document, ou si la suivante commence par une minuscule. L'en-tête (avant la
 * première rubrique) n'est jamais recollé : il contient nom, titre et coordonnées.
 */
function unwrap(lines: string[]): string[] {
  const lengths = lines.map((l) => l.trimEnd().length).filter((n) => n > 20).sort((a, b) => a - b);
  const width = lengths.length ? lengths[Math.floor(lengths.length * 0.95)]! : 0;
  const out: string[] = [];
  let prevPhysical = 0;
  let inBody = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = isHeading(line);
    if (heading) inBody = true;
    const prev = out[out.length - 1];
    const eligible =
      inBody && !heading && prev !== undefined && prev.trim() !== '' && line.trim() !== '' && !BULLET_RE.test(line) && !isHeading(prev) && !/[.!?:;]$/.test(prev.trim()) && !extractDateRange(line);
    const wrapped = width > 40 && prevPhysical >= width * 0.86;
    const lowercaseStart = /^\s*[a-zà-ÿ(0-9%€$]/.test(line) && (BULLET_RE.test(prev ?? '') || prevPhysical > 60);
    if (eligible && (wrapped || lowercaseStart)) out[out.length - 1] = `${prev} ${line.trim()}`;
    else out.push(line);
    prevPhysical = line.length;
  }
  return out;
}

/** Découpe une liste sur les séparateurs usuels, sans couper à l'intérieur de parenthèses. */
export function splitList(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && /[,;•·|]/.test(ch)) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

function splitSegments(text: string): string[] {
  return text
    .split(/\s+[—–|@]\s+|\s{3,}|\s-\s|\bchez\b|\s+at\s+/i)
    .map((s) => s.replace(/^[\s,;:()-]+|[\s,;:(-]+$/g, '').trim())
    .filter(Boolean);
}

function classifyHeader(lines: string[], kind: 'experience' | 'education') {
  const segs = lines.flatMap(splitSegments);
  const out = { primary: '', secondary: '', location: '' };
  const rest: string[] = [];
  for (const seg of segs) {
    const n = normalize(seg);
    const looksLocation = LOCATION_HINT.test(n) && n.split(' ').length <= 5 && !TITLE_WORDS.test(n) && !DEGREE_WORDS.test(n);
    if (looksLocation && !out.location) out.location = seg;
    else rest.push(seg);
  }
  const marker = kind === 'experience' ? TITLE_WORDS : DEGREE_WORDS;
  const idx = rest.findIndex((s) => marker.test(normalize(s)));
  if (idx >= 0) {
    out.secondary = rest[idx]!; // intitulé de poste ou diplôme
    out.primary = rest.filter((_, i) => i !== idx).join(', '); // entreprise ou école
  } else {
    out.primary = rest[0] ?? '';
    out.secondary = rest.slice(1).join(', ');
  }
  return out;
}

interface Entry {
  header: string[];
  start: string;
  end: string;
  bullets: string[];
}

/** Découpe une section en entrées : une entrée commence autour d'une ligne portant une période. */
function splitEntries(lines: string[]): Entry[] {
  const entries: Entry[] = [];
  let pendingHeader: string[] = [];
  let current: Entry | null = null;
  const flushHeaderInto = (e: Entry) => {
    e.header.unshift(...pendingHeader);
    pendingHeader = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (current && pendingHeader.length === 0) continue;
      continue;
    }
    const range = !BULLET_RE.test(line) ? extractDateRange(line) : null;
    if (range) {
      current = { header: range.rest ? [range.rest] : [], start: range.start, end: range.end, bullets: [] };
      flushHeaderInto(current);
      entries.push(current);
      continue;
    }
    if (BULLET_RE.test(line)) {
      if (!current) {
        current = { header: [], start: '', end: '', bullets: [] };
        flushHeaderInto(current);
        entries.push(current);
      }
      if (pendingHeader.length) {
        // Lignes non listées entre deux puces : elles appartiennent à l'entrée en cours.
        current.bullets.push(...pendingHeader);
        pendingHeader = [];
      }
      current.bullets.push(line.replace(BULLET_RE, '').trim());
      continue;
    }
    // Ligne simple : en-tête de la prochaine entrée, ou suite de l'en-tête courant s'il n'a pas encore de puces.
    if (current && current.bullets.length === 0 && current.header.length < 3 && pendingHeader.length === 0 && line.length < 120) current.header.push(line);
    else pendingHeader.push(line);
  }
  if (pendingHeader.length) {
    if (current) current.bullets.push(...pendingHeader);
    else entries.push({ header: pendingHeader, start: '', end: '', bullets: [] });
  }
  return entries;
}

function parseContact(lines: string[], cv: CvData) {
  const blob = lines.join(' | ');
  const email = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.exec(blob)?.[0] ?? '';
  const linkedin = /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[^\s|,;)]+/i.exec(blob)?.[0] ?? '';
  const phone = /(?:\+|00)?\d[\d\s().-]{7,17}\d/.exec(blob.replace(email, '').replace(linkedin, ''))?.[0]?.trim() ?? '';
  cv.identity.email = email;
  cv.identity.linkedin = linkedin;
  cv.identity.phone = phone;
  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
  if (nonEmpty[0] && !nonEmpty[0].includes('@') && nonEmpty[0].split(/\s+/).length <= 6) cv.identity.fullName = nonEmpty[0];
  for (const line of nonEmpty.slice(1)) {
    const hasContact = (email && line.includes(email)) || (phone && line.includes(phone)) || (linkedin && line.includes(linkedin));
    if (hasContact) {
      const leftovers = line
        .split(/\s*[|•·]\s*|\s{3,}/)
        .map((s) => s.trim())
        .filter((s) => s && s !== email && s !== phone && s !== linkedin && !/https?:\/\/|www\./i.test(s));
      for (const seg of leftovers) {
        if (!cv.identity.location && LOCATION_HINT.test(normalize(seg))) cv.identity.location = seg;
      }
    } else if (!cv.identity.headline && line.length < 140) cv.identity.headline = line;
  }
}

export function parseCvHeuristic(text: string, language = 'fr'): CvData {
  const cv = emptyCv(language);
  const lines = unwrap(text.replace(/\r/g, '').split('\n'));
  const sections: { key: SectionKey | 'header'; title: string; lines: string[] }[] = [{ key: 'header', title: '', lines: [] }];
  for (const line of lines) {
    const h = isHeading(line);
    if (h) sections.push({ key: h, title: line.trim().replace(/[:：]\s*$/, ''), lines: [] });
    else sections[sections.length - 1]!.lines.push(line);
  }

  for (const s of sections) {
    const body = s.lines.map((l) => l.trim()).filter(Boolean);
    switch (s.key) {
      case 'header':
        parseContact(s.lines, cv);
        break;
      case 'summary':
        cv.summary = body.map((l) => l.replace(BULLET_RE, '')).join(' ');
        break;
      case 'experiences':
        for (const e of splitEntries(s.lines)) {
          const h = classifyHeader(e.header, 'experience');
          if (!h.primary && !h.secondary && e.bullets.length === 0) continue;
          cv.experiences.push({ id: '', company: h.primary, title: h.secondary, location: h.location, start: e.start, end: e.end, contract: '', summary: '', bullets: e.bullets.map((b) => ({ id: '', text: b })) });
        }
        break;
      case 'education':
        for (const e of splitEntries(s.lines)) {
          const h = classifyHeader(e.header, 'education');
          if (!h.primary && !h.secondary) continue;
          cv.education.push({ id: '', school: h.primary, degree: h.secondary, field: '', location: h.location, start: e.start, end: e.end, details: e.bullets.map((b) => ({ id: '', text: b })) });
        }
        break;
      case 'skills':
        for (const line of body) {
          const clean = line.replace(BULLET_RE, '');
          const m = /^([^:：]{2,40})\s*[:：]\s*(.+)$/.exec(clean);
          if (m) cv.skills.push({ id: '', label: m[1]!.trim(), items: splitList(m[2]!) });
          else {
            const last = cv.skills[cv.skills.length - 1];
            if (last && last.label === '') last.items.push(...splitList(clean));
            else cv.skills.push({ id: '', label: '', items: splitList(clean) });
          }
        }
        break;
      case 'languages':
        for (const line of body) {
          for (const part of line.replace(BULLET_RE, '').split(/\s*[;|•·]\s*/)) {
            const p = part.trim();
            if (!p) continue;
            // « Anglais : courant (TOEIC 965) », « Anglais - courant » ou « Anglais (C1) ».
            const labelled = /^([^:：(–—-]+?)\s*[:：–—-]\s*(.+)$/.exec(p);
            const bare = /^([^(]+?)\s*\(([^)]+)\)\s*$/.exec(p);
            if (labelled) {
              const cert = /\s*\(([^)]+)\)\s*$/.exec(labelled[2]!);
              cv.languages.push({ id: '', language: labelled[1]!.trim(), level: (cert ? labelled[2]!.slice(0, cert.index) : labelled[2]!).trim(), certification: cert?.[1]?.trim() ?? '' });
            } else if (bare) cv.languages.push({ id: '', language: bare[1]!.trim(), level: bare[2]!.trim(), certification: '' });
            else cv.languages.push({ id: '', language: p, level: '', certification: '' });
          }
        }
        break;
      case 'certifications':
        for (const line of body) {
          const clean = line.replace(BULLET_RE, '');
          const date = /\(?\b((?:19|20)\d{2})\)?\s*$/.exec(clean);
          const main = (date ? clean.slice(0, date.index) : clean).trim().replace(/[,;(–—-]+$/, '').trim();
          const parts = main.split(/\s+[—–|]\s+|\s-\s/);
          if (parts.length >= 2) cv.certifications.push({ id: '', issuer: parts[0]!.trim(), name: parts.slice(1).join(' — ').trim(), date: date ? parsePartialDate(date[1]) : '' });
          else cv.certifications.push({ id: '', name: main, issuer: '', date: date ? parsePartialDate(date[1]) : '' });
        }
        break;
      case 'extras':
        cv.extras.push({ id: '', title: s.title, items: body.map((l) => ({ id: '', text: l.replace(BULLET_RE, '') })) });
        break;
    }
  }
  return assignIds(cv);
}
