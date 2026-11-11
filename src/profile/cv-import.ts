// Structuration d'un CV importé en données (CvData). Deux voies :
//  - modèle IA (lecture fidèle, y compris des mises en page complexes) ;
//  - analyse par règles en secours si aucun modèle n'est disponible.
// Dans les deux cas, chaque valeur est ensuite confrontée au texte source : tout
// élément qui n'y figure pas est signalé à l'utilisateur avant validation.
import { z } from 'zod';
import type { UserContext } from '../core/context.js';
import { coverage, detectLanguage, tokens } from '../core/text.js';
import { getLlm, llmAvailability } from '../llm/index.js';
import { registerMock } from '../llm/mock.js';
import { type CvData, CvData as CvDataSchema, assignIds, stripMarkup } from '../shared/cv.js';
import { parseCvHeuristic } from './cv-parse.js';
import { parsePartialDate } from './dates.js';

const s = z.string();
export const CvExtraction = z.object({
  language: s.describe('Langue du document, code ISO 639-1 (fr, en, es, de…)'),
  identity: z.object({ fullName: s, headline: s, email: s, phone: s, location: s, linkedin: s, website: s }),
  summary: s,
  experiences: z.array(
    z.object({
      company: s,
      title: s,
      location: s,
      start: s.describe('AAAA-MM si le mois est indiqué, sinon AAAA, sinon vide'),
      end: s.describe('AAAA-MM, AAAA, "present" si en cours, sinon vide'),
      dates: s.describe('Période exactement telle qu\'elle est écrite dans le document (ex. « Sept 2023 – Current »)'),
      contract: s.describe('Type de contrat seulement s\'il est écrit (stage, alternance, CDI…), sinon vide'),
      summary: s,
      bullets: z.array(s),
    }),
  ),
  education: z.array(z.object({ school: s, degree: s, field: s, location: s, start: s, end: s, dates: s, details: z.array(s) })),
  skills: z.array(z.object({ label: s, items: z.array(s) })),
  languages: z.array(z.object({ language: s, level: s, certification: s })),
  certifications: z.array(z.object({ name: s, issuer: s, date: s })),
  extras: z.array(z.object({ title: s, items: z.array(s) })),
  titles: z
    .object({ summary: s, experiences: s, education: s, skills: s, languages: s, certifications: s })
    .describe('Titres des rubriques exactement tels qu\'écrits dans le document ; vide si la rubrique est absente'),
});
export type CvExtraction = z.infer<typeof CvExtraction>;

export const CV_STRUCTURE_SYSTEM = `Tu transcris un CV en données structurées. Ta seule tâche est une transcription fidèle.

Règles :
- Recopie les textes mot pour mot, dans la langue du document. Ne reformule pas, ne corrige pas, ne traduis pas, ne résume pas.
- N'ajoute rien qui ne soit pas écrit dans le document : ni compétence, ni date, ni intitulé, ni lieu. Un champ absent reste une chaîne vide.
- Conserve tous les éléments du document, dans leur ordre d'apparition. N'en omets aucun.
- Une puce du document = un élément de liste. Recolle les lignes coupées par la mise en page.
- Dates : "AAAA-MM" quand le mois est indiqué, "AAAA" sinon, "present" pour un poste en cours.
- Compétences : garde les regroupements du document (libellé + éléments). Sans regroupement, un seul groupe au libellé vide.
- Respecte le découpage en rubriques du document. Seules les rubriques consacrées aux compétences, aux langues ou aux certifications alimentent "skills", "languages" et "certifications". Toute autre rubrique (centres d'intérêt, engagements, projets, ou une rubrique mixte du type « Compétences et activités ») va dans "extras" avec son titre d'origine et ses éléments tels quels.
- Mise en valeur : quand une partie seulement d'un élément est en gras ou en italique dans le document, encadre-la par **gras** ou *italique*. N'utilise aucune balise si l'élément entier a la même mise en forme.
- Un élément de liste qui est un paragraphe simple (sans puce) dans le document commence par le caractère ¶.
- "dates" reprend la période exactement telle qu'elle est écrite ; "titles" reprend les titres de rubriques exactement tels qu'ils sont écrits.`;

/** Un élément préfixé par « ¶ » est un paragraphe simple (sans puce) dans le document d'origine. */
function toItem(text: string): { id: string; text: string; kind?: 'text' } {
  const t = text.trim();
  return t.startsWith('¶') ? { id: '', text: t.replace(/^¶\s*/, ''), kind: 'text' } : { id: '', text: t };
}

function toCvData(x: CvExtraction): CvData {
  const d = (v: string) => (v === 'present' ? 'present' : parsePartialDate(v));
  return assignIds(
    CvDataSchema.parse({
      language: (x.language || 'fr').slice(0, 2).toLowerCase(),
      identity: { ...x.identity, extra: [] },
      summary: x.summary,
      experiences: x.experiences.map((e) => ({ id: '', company: e.company, title: e.title, location: e.location, start: d(e.start), end: d(e.end), dates: e.dates, contract: e.contract, summary: e.summary, bullets: e.bullets.filter(Boolean).map(toItem) })),
      education: x.education.map((e) => ({ id: '', school: e.school, degree: e.degree, field: e.field, location: e.location, start: d(e.start), end: d(e.end), dates: e.dates, details: e.details.filter(Boolean).map(toItem) })),
      skills: x.skills.map((g) => ({ id: '', label: g.label, items: g.items.filter(Boolean) })),
      languages: x.languages.map((l) => ({ id: '', ...l })),
      certifications: x.certifications.map((c) => ({ id: '', ...c })),
      extras: x.extras.map((g) => ({ id: '', title: g.title, items: g.items.filter(Boolean).map(toItem) })),
      titles: Object.fromEntries(Object.entries(x.titles ?? {}).filter(([, v]) => v)),
    }),
  );
}

const fromItem = (b: { text: string; kind?: string }) => (b.kind === 'text' ? `¶ ${b.text}` : b.text);

function toExtraction(cv: CvData): CvExtraction {
  return {
    language: cv.language,
    identity: { fullName: cv.identity.fullName, headline: cv.identity.headline, email: cv.identity.email, phone: cv.identity.phone, location: cv.identity.location, linkedin: cv.identity.linkedin, website: cv.identity.website },
    summary: cv.summary,
    experiences: cv.experiences.map((e) => ({ company: e.company, title: e.title, location: e.location, start: e.start, end: e.end, dates: e.dates ?? '', contract: e.contract, summary: e.summary, bullets: e.bullets.map(fromItem) })),
    education: cv.education.map((e) => ({ school: e.school, degree: e.degree, field: e.field, location: e.location, start: e.start, end: e.end, dates: e.dates ?? '', details: e.details.map(fromItem) })),
    skills: cv.skills.map((g) => ({ label: g.label, items: g.items })),
    languages: cv.languages.map((l) => ({ language: l.language, level: l.level, certification: l.certification })),
    certifications: cv.certifications.map((c) => ({ name: c.name, issuer: c.issuer, date: c.date })),
    extras: cv.extras.map((g) => ({ title: g.title, items: g.items.map(fromItem) })),
    titles: { summary: cv.titles?.summary ?? '', experiences: cv.titles?.experiences ?? '', education: cv.titles?.education ?? '', skills: cv.titles?.skills ?? '', languages: cv.titles?.languages ?? '', certifications: cv.titles?.certifications ?? '' },
  };
}

export interface GroundingWarning {
  path: string;
  value: string;
  /** Part des mots de la valeur retrouvés dans le texte source (0..1). */
  coverage: number;
}

/** Signale toute valeur dont les mots ne se retrouvent pas (assez) dans le texte source. */
export function groundingWarnings(cv: CvData, sourceText: string, threshold = 0.75): GroundingWarning[] {
  const source = new Set(tokens(stripMarkup(sourceText)));
  const out: GroundingWarning[] = [];
  const check = (path: string, value: string) => {
    if (!value || value.length < 3) return;
    const c = coverage(stripMarkup(value), source);
    if (c < threshold) out.push({ path, value, coverage: Math.round(c * 100) / 100 });
  };
  check('identity.fullName', cv.identity.fullName);
  check('identity.headline', cv.identity.headline);
  check('summary', cv.summary);
  cv.experiences.forEach((e) => {
    check(`${e.id}.company`, e.company);
    check(`${e.id}.title`, e.title);
    check(`${e.id}.location`, e.location);
    e.bullets.forEach((b) => check(b.id, b.text));
  });
  cv.education.forEach((e) => {
    check(`${e.id}.school`, e.school);
    check(`${e.id}.degree`, e.degree);
    e.details.forEach((b) => check(b.id, b.text));
  });
  cv.skills.forEach((g) => g.items.forEach((item, i) => check(`${g.id}.${i}`, item)));
  cv.languages.forEach((l) => check(l.id, `${l.language} ${l.level}`));
  cv.certifications.forEach((c) => check(c.id, c.name));
  cv.extras.forEach((x) => x.items.forEach((b) => check(b.id, b.text)));
  return out;
}

export interface StructureResult {
  cv: CvData;
  method: 'llm' | 'rules';
  warnings: GroundingWarning[];
}

export async function structureCv(ctx: UserContext, input: { text: string; pdf?: Uint8Array; kind?: 'cv' | 'linkedin_profile' }): Promise<StructureResult> {
  const availability = await llmAvailability(ctx);
  if (!availability.available) {
    const cv = parseCvHeuristic(input.text, detectLanguage(input.text) || 'fr');
    return { cv, method: 'rules', warnings: groundingWarnings(cv, input.text) };
  }
  const llm = await getLlm(ctx);
  const what = input.kind === 'linkedin_profile' ? "l'export PDF d'un profil LinkedIn (la colonne latérale contient coordonnées, compétences, langues et certifications)" : 'un CV';
  const res = await llm.json({
    purpose: 'cv.structure',
    tier: 'main',
    effort: 'low',
    system: CV_STRUCTURE_SYSTEM,
    documents: input.pdf ? [{ mediaType: 'application/pdf', data: input.pdf }] : undefined,
    prompt: `Voici ${what}. ${input.pdf ? 'Le document original est joint ; le texte extrait ci-dessous sert de contrôle.' : ''}\n\n<cv_texte>\n${input.text}\n</cv_texte>\n\nTranscris-le intégralement dans la structure demandée.`,
    schema: CvExtraction,
    maxTokens: 16_000,
  });
  if (res.refused) {
    const cv = parseCvHeuristic(input.text, detectLanguage(input.text) || 'fr');
    return { cv, method: 'rules', warnings: groundingWarnings(cv, input.text) };
  }
  const cv = toCvData(res.data);
  return { cv, method: 'llm', warnings: groundingWarnings(cv, input.text) };
}

// Simulation (tests, démonstration) : l'analyse par règles tient lieu de modèle.
registerMock('cv.structure', (req) => {
  const m = /<cv_texte>\n([\s\S]*?)\n<\/cv_texte>/.exec(req.prompt);
  const text = m?.[1] ?? '';
  return toExtraction(parseCvHeuristic(text, detectLanguage(text) || 'fr'));
});
