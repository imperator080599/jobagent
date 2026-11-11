// Modèle structuré d'un CV. C'est la représentation de référence : le CV master,
// les versions spécialisées et les versions par candidature partagent ce schéma.
// Les identifiants (exp_1, exp_1.b2…) sont stables au sein d'un master : un CV
// personnalisé référence toujours les éléments du master dont il dérive.
import { z } from 'zod';

/** Date partielle : "2023", "2023-09" ou "present". */
export const PartialDate = z
  .string()
  .regex(/^(\d{4}(-(0[1-9]|1[0-2]))?|present)$/, 'Format attendu : AAAA, AAAA-MM ou "present"');

/**
 * Élément de liste. Le texte peut porter une mise en valeur légère, reprise du
 * document d'origine : **gras** et *italique*. `kind: 'text'` désigne un paragraphe
 * simple (sans puce).
 */
export const Bullet = z.object({
  id: z.string(),
  text: z.string(),
  kind: z.enum(['bullet', 'text']).optional(),
});

export const Experience = z.object({
  id: z.string(),
  company: z.string(),
  title: z.string(),
  location: z.string().optional().default(''),
  start: PartialDate.or(z.literal('')).optional().default(''),
  end: PartialDate.or(z.literal('')).optional().default(''),
  /** Période telle qu'elle est écrite dans le document d'origine (« Sept 2023 – Current »). */
  dates: z.string().optional().default(''),
  contract: z.string().optional().default(''),
  summary: z.string().optional().default(''),
  bullets: z.array(Bullet).default([]),
});

export const Education = z.object({
  id: z.string(),
  school: z.string(),
  degree: z.string(),
  field: z.string().optional().default(''),
  location: z.string().optional().default(''),
  start: PartialDate.or(z.literal('')).optional().default(''),
  end: PartialDate.or(z.literal('')).optional().default(''),
  dates: z.string().optional().default(''),
  details: z.array(Bullet).default([]),
});

export const SkillGroup = z.object({
  id: z.string(),
  label: z.string(),
  items: z.array(z.string()).default([]),
});

export const LanguageItem = z.object({
  id: z.string(),
  language: z.string(),
  level: z.string().optional().default(''),
  certification: z.string().optional().default(''),
});

export const Certification = z.object({
  id: z.string(),
  name: z.string(),
  issuer: z.string().optional().default(''),
  date: z.string().optional().default(''),
});

export const ExtraSection = z.object({
  id: z.string(),
  title: z.string(),
  items: z.array(Bullet).default([]),
});

export const Identity = z.object({
  fullName: z.string().default(''),
  headline: z.string().optional().default(''),
  email: z.string().optional().default(''),
  phone: z.string().optional().default(''),
  location: z.string().optional().default(''),
  linkedin: z.string().optional().default(''),
  website: z.string().optional().default(''),
  extra: z.array(z.string()).optional().default([]),
});

export const CvData = z.object({
  language: z.string().default('fr'),
  identity: Identity.default({
    fullName: '',
    headline: '',
    email: '',
    phone: '',
    location: '',
    linkedin: '',
    website: '',
    extra: [],
  }),
  summary: z.string().optional().default(''),
  experiences: z.array(Experience).default([]),
  education: z.array(Education).default([]),
  skills: z.array(SkillGroup).default([]),
  languages: z.array(LanguageItem).default([]),
  certifications: z.array(Certification).default([]),
  extras: z.array(ExtraSection).default([]),
  /** Titres de rubriques tels qu'ils figurent dans le document d'origine (ex. « WORK & VOLUNTEERING EXPERIENCE »). */
  titles: z.record(z.string(), z.string()).optional().default({}),
  /** Ordre d'affichage des sections (les sections vides sont ignorées au rendu). */
  sectionOrder: z
    .array(z.enum(['summary', 'experiences', 'education', 'skills', 'languages', 'certifications', 'extras']))
    .optional()
    .default(['summary', 'experiences', 'education', 'skills', 'languages', 'certifications', 'extras']),
});

export type CvData = z.infer<typeof CvData>;
export type Experience = z.infer<typeof Experience>;
export type Education = z.infer<typeof Education>;
export type Bullet = z.infer<typeof Bullet>;
export type SkillGroup = z.infer<typeof SkillGroup>;
export type LanguageItem = z.infer<typeof LanguageItem>;
export type Certification = z.infer<typeof Certification>;
export type ExtraSection = z.infer<typeof ExtraSection>;

export function emptyCv(language = 'fr'): CvData {
  return CvData.parse({ language });
}

/**
 * Attribue un identifiant aux éléments qui n'en ont pas, sans jamais modifier un
 * identifiant existant : les CV personnalisés et les écarts LinkedIn référencent
 * les éléments du master par leur identifiant, qui doit donc rester stable d'une
 * version à l'autre.
 */
export function assignIds(cv: CvData): CvData {
  const out: CvData = structuredClone(cv);
  const seen = new Set<string>();
  const pending: { set: (id: string) => void; prefix: string }[] = [];
  const claim = (current: string, prefix: string, set: (id: string) => void) => {
    if (current && !seen.has(current)) seen.add(current);
    else pending.push({ set, prefix });
  };
  const flush = () => {
    for (const p of pending.splice(0)) {
      let max = 0;
      for (const id of seen) {
        if (id.startsWith(p.prefix)) {
          const n = Number(id.slice(p.prefix.length));
          if (Number.isInteger(n) && n > max) max = n;
        }
      }
      const id = `${p.prefix}${max + 1}`;
      seen.add(id);
      p.set(id);
    }
  };
  // Premier niveau d'abord (les sous-éléments dérivent leur préfixe de l'identifiant du parent).
  out.experiences.forEach((e) => claim(e.id, 'exp_', (id) => (e.id = id)));
  out.education.forEach((e) => claim(e.id, 'edu_', (id) => (e.id = id)));
  out.skills.forEach((x) => claim(x.id, 'skill_', (id) => (x.id = id)));
  out.languages.forEach((x) => claim(x.id, 'lang_', (id) => (x.id = id)));
  out.certifications.forEach((x) => claim(x.id, 'cert_', (id) => (x.id = id)));
  out.extras.forEach((x) => claim(x.id, 'extra_', (id) => (x.id = id)));
  flush();
  out.experiences.forEach((e) => e.bullets.forEach((b) => claim(b.id, `${e.id}.b`, (id) => (b.id = id))));
  out.education.forEach((e) => e.details.forEach((b) => claim(b.id, `${e.id}.d`, (id) => (b.id = id))));
  out.extras.forEach((x) => x.items.forEach((b) => claim(b.id, `${x.id}.i`, (id) => (b.id = id))));
  flush();
  return out;
}

/**
 * Remet d'aplomb une mise en valeur balisée : fusionne les passages contigus de
 * même nature (un passage en gras coupé par un retour à la ligne, par exemple) et
 * retire toute balise orpheline, pour qu'aucun astérisque ne se retrouve dans un document.
 */
export function normalizeMarkup(text: string): string {
  let out = text
    .replace(/\*\*\*(\s*)\*\*\*/g, '$1')
    .replace(/(?<!\*)\*\*(\s*)\*\*(?!\*)/g, '$1')
    .replace(/(?<![*\w])\*(\s+)\*(?![*\s])/g, '$1');
  // Balises orphelines : si une nature de balise est en nombre impair, elle est retirée entièrement.
  for (const mark of ['***', '**']) {
    const re = mark === '***' ? /\*\*\*/g : /(?<!\*)\*\*(?!\*)/g;
    if ((out.match(re) ?? []).length % 2 === 1) out = out.replace(re, '');
  }
  const spans = parseMarkup(out);
  // Astérisque isolé collé à un mot : reste d'une balise mal fermée.
  if (spans.some((s) => /(^|\s)\*\S|\S\*(\s|$)/.test(s.text))) out = out.replace(/(?<!\*)\*(?!\*)/g, (m, off: number, str: string) => (/\d\s?$/.test(str.slice(0, off)) && /^\s?\d/.test(str.slice(off + 1)) ? m : ''));
  return out;
}

/** Retire la mise en valeur (**gras**, *italique*) d'un texte. */
export function stripMarkup(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?![*\w])/g, '$1$2');
}

export interface MarkupSpan {
  text: string;
  bold: boolean;
  italic: boolean;
}

/** Découpe un texte balisé en segments de mise en forme homogène. */
export function parseMarkup(text: string): MarkupSpan[] {
  const out: MarkupSpan[] = [];
  const re = /\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|(?<![*\w])\*(?!\s)([^*\n]+?)\*(?![*\w])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), bold: false, italic: false });
    if (m[1] !== undefined) out.push({ text: m[1], bold: true, italic: true });
    else if (m[2] !== undefined) out.push({ text: m[2], bold: true, italic: false });
    else out.push({ text: m[3]!, bold: false, italic: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), bold: false, italic: false });
  return out.filter((s) => s.text.length > 0);
}

/** Texte brut du CV (pour les prompts, la recherche de mots-clés et les contrôles). La mise en valeur est retirée. */
export function cvToText(cv: CvData): string {
  return stripMarkup(cvToMarkedText(cv));
}

/** Texte du CV avec la mise en valeur d'origine (**gras**, *italique*). */
export function cvToMarkedText(cv: CvData): string {
  const L: string[] = [];
  const id = cv.identity;
  if (id.fullName) L.push(id.fullName);
  if (id.headline) L.push(id.headline);
  const contact = [id.email, id.phone, id.location, id.linkedin, id.website, ...(id.extra ?? [])].filter(Boolean);
  if (contact.length) L.push(contact.join(' | '));
  const period = (s?: string, e?: string, display?: string) => display || [fmtDate(s, cv.language), fmtDate(e, cv.language)].filter(Boolean).join(' – ');
  for (const section of cv.sectionOrder) {
    if (section === 'summary' && cv.summary) L.push('', cv.titles?.summary || 'PROFIL', cv.summary);
    if (section === 'experiences' && cv.experiences.length) {
      L.push('', cv.titles?.experiences || 'EXPÉRIENCES PROFESSIONNELLES');
      for (const e of cv.experiences) {
        L.push(`${e.title} — ${e.company}${e.location ? ` (${e.location})` : ''}${period(e.start, e.end, e.dates) ? ` | ${period(e.start, e.end, e.dates)}` : ''}`);
        if (e.summary) L.push(e.summary);
        for (const b of e.bullets) L.push(b.kind === 'text' ? b.text : `- ${b.text}`);
      }
    }
    if (section === 'education' && cv.education.length) {
      L.push('', cv.titles?.education || 'FORMATION');
      for (const e of cv.education) {
        L.push(`${e.degree}${e.field ? `, ${e.field}` : ''} — ${e.school}${e.location ? ` (${e.location})` : ''}${period(e.start, e.end, e.dates) ? ` | ${period(e.start, e.end, e.dates)}` : ''}`);
        for (const b of e.details) L.push(b.kind === 'text' ? b.text : `- ${b.text}`);
      }
    }
    if (section === 'skills' && cv.skills.length) {
      L.push('', cv.titles?.skills || 'COMPÉTENCES');
      for (const s of cv.skills) L.push(`${s.label ? `${s.label} : ` : ''}${s.items.join(', ')}`);
    }
    if (section === 'languages' && cv.languages.length) {
      L.push('', cv.titles?.languages || 'LANGUES');
      for (const l of cv.languages) L.push(`${l.language}${l.level ? ` : ${l.level}` : ''}${l.certification ? ` (${l.certification})` : ''}`);
    }
    if (section === 'certifications' && cv.certifications.length) {
      L.push('', cv.titles?.certifications || 'CERTIFICATIONS');
      for (const c of cv.certifications) L.push(`${c.name}${c.issuer ? ` — ${c.issuer}` : ''}${c.date ? ` (${c.date})` : ''}`);
    }
    if (section === 'extras') {
      for (const x of cv.extras) {
        if (!x.items.length) continue;
        L.push('', x.title.toUpperCase());
        for (const b of x.items) L.push(b.kind === 'text' ? b.text : `- ${b.text}`);
      }
    }
  }
  return L.join('\n').trim();
}

export function fmtDate(d?: string, lang = 'fr'): string {
  if (!d) return '';
  if (d === 'present') return lang === 'fr' ? "Aujourd'hui" : lang === 'es' ? 'Actualidad' : lang === 'de' ? 'Heute' : 'Present';
  const m = /^(\d{4})(?:-(\d{2}))?$/.exec(d);
  if (!m) return d;
  if (!m[2]) return m[1]!;
  return `${m[2]}/${m[1]}`;
}
