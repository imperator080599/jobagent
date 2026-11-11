// Modèle structuré d'un CV. C'est la représentation de référence : le CV master,
// les versions spécialisées et les versions par candidature partagent ce schéma.
// Les identifiants (exp_1, exp_1.b2…) sont stables au sein d'un master : un CV
// personnalisé référence toujours les éléments du master dont il dérive.
import { z } from 'zod';

/** Date partielle : "2023", "2023-09" ou "present". */
export const PartialDate = z
  .string()
  .regex(/^(\d{4}(-(0[1-9]|1[0-2]))?|present)$/, 'Format attendu : AAAA, AAAA-MM ou "present"');

export const Bullet = z.object({
  id: z.string(),
  text: z.string(),
});

export const Experience = z.object({
  id: z.string(),
  company: z.string(),
  title: z.string(),
  location: z.string().optional().default(''),
  start: PartialDate.or(z.literal('')).optional().default(''),
  end: PartialDate.or(z.literal('')).optional().default(''),
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

/** Réattribue des identifiants stables et uniques (après import ou édition manuelle). */
export function assignIds(cv: CvData): CvData {
  const out: CvData = structuredClone(cv);
  const seen = new Set<string>();
  const uniq = (wanted: string, fallback: string) => {
    let id = wanted && !seen.has(wanted) ? wanted : fallback;
    let n = 2;
    while (seen.has(id)) id = `${fallback}_${n++}`;
    seen.add(id);
    return id;
  };
  out.experiences.forEach((e, i) => {
    e.id = uniq(e.id, `exp_${i + 1}`);
    e.bullets.forEach((b, j) => (b.id = uniq(b.id, `${e.id}.b${j + 1}`)));
  });
  out.education.forEach((e, i) => {
    e.id = uniq(e.id, `edu_${i + 1}`);
    e.details.forEach((b, j) => (b.id = uniq(b.id, `${e.id}.d${j + 1}`)));
  });
  out.skills.forEach((s, i) => (s.id = uniq(s.id, `skill_${i + 1}`)));
  out.languages.forEach((l, i) => (l.id = uniq(l.id, `lang_${i + 1}`)));
  out.certifications.forEach((c, i) => (c.id = uniq(c.id, `cert_${i + 1}`)));
  out.extras.forEach((x, i) => {
    x.id = uniq(x.id, `extra_${i + 1}`);
    x.items.forEach((b, j) => (b.id = uniq(b.id, `${x.id}.i${j + 1}`)));
  });
  return out;
}

/** Texte brut du CV (pour les prompts, la recherche de mots-clés et les contrôles). */
export function cvToText(cv: CvData): string {
  const L: string[] = [];
  const id = cv.identity;
  if (id.fullName) L.push(id.fullName);
  if (id.headline) L.push(id.headline);
  const contact = [id.email, id.phone, id.location, id.linkedin, id.website, ...(id.extra ?? [])].filter(Boolean);
  if (contact.length) L.push(contact.join(' | '));
  const period = (s?: string, e?: string) => [fmtDate(s), fmtDate(e)].filter(Boolean).join(' – ');
  for (const section of cv.sectionOrder) {
    if (section === 'summary' && cv.summary) L.push('', 'PROFIL', cv.summary);
    if (section === 'experiences' && cv.experiences.length) {
      L.push('', 'EXPÉRIENCES PROFESSIONNELLES');
      for (const e of cv.experiences) {
        L.push(`${e.title} — ${e.company}${e.location ? ` (${e.location})` : ''}${period(e.start, e.end) ? ` | ${period(e.start, e.end)}` : ''}`);
        if (e.summary) L.push(e.summary);
        for (const b of e.bullets) L.push(`- ${b.text}`);
      }
    }
    if (section === 'education' && cv.education.length) {
      L.push('', 'FORMATION');
      for (const e of cv.education) {
        L.push(`${e.degree}${e.field ? `, ${e.field}` : ''} — ${e.school}${e.location ? ` (${e.location})` : ''}${period(e.start, e.end) ? ` | ${period(e.start, e.end)}` : ''}`);
        for (const b of e.details) L.push(`- ${b.text}`);
      }
    }
    if (section === 'skills' && cv.skills.length) {
      L.push('', 'COMPÉTENCES');
      for (const s of cv.skills) L.push(`${s.label ? `${s.label} : ` : ''}${s.items.join(', ')}`);
    }
    if (section === 'languages' && cv.languages.length) {
      L.push('', 'LANGUES');
      for (const l of cv.languages) L.push(`${l.language}${l.level ? ` : ${l.level}` : ''}${l.certification ? ` (${l.certification})` : ''}`);
    }
    if (section === 'certifications' && cv.certifications.length) {
      L.push('', 'CERTIFICATIONS');
      for (const c of cv.certifications) L.push(`${c.name}${c.issuer ? ` — ${c.issuer}` : ''}${c.date ? ` (${c.date})` : ''}`);
    }
    if (section === 'extras') {
      for (const x of cv.extras) {
        if (!x.items.length) continue;
        L.push('', x.title.toUpperCase());
        for (const b of x.items) L.push(`- ${b.text}`);
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
