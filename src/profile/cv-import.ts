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
import { type CvData, CvData as CvDataSchema, assignIds } from '../shared/cv.js';
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
      contract: s.describe('Type de contrat seulement s\'il est écrit (stage, alternance, CDI…), sinon vide'),
      summary: s,
      bullets: z.array(s),
    }),
  ),
  education: z.array(z.object({ school: s, degree: s, field: s, location: s, start: s, end: s, details: z.array(s) })),
  skills: z.array(z.object({ label: s, items: z.array(s) })),
  languages: z.array(z.object({ language: s, level: s, certification: s })),
  certifications: z.array(z.object({ name: s, issuer: s, date: s })),
  extras: z.array(z.object({ title: s, items: z.array(s) })),
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
- Les rubriques hors expériences, formation, compétences, langues et certifications (centres d'intérêt, engagements, projets…) vont dans "extras" avec leur titre d'origine.`;

function toCvData(x: CvExtraction): CvData {
  const d = (v: string) => (v === 'present' ? 'present' : parsePartialDate(v));
  return assignIds(
    CvDataSchema.parse({
      language: (x.language || 'fr').slice(0, 2).toLowerCase(),
      identity: { ...x.identity, extra: [] },
      summary: x.summary,
      experiences: x.experiences.map((e) => ({ id: '', company: e.company, title: e.title, location: e.location, start: d(e.start), end: d(e.end), contract: e.contract, summary: e.summary, bullets: e.bullets.filter(Boolean).map((t) => ({ id: '', text: t })) })),
      education: x.education.map((e) => ({ id: '', school: e.school, degree: e.degree, field: e.field, location: e.location, start: d(e.start), end: d(e.end), details: e.details.filter(Boolean).map((t) => ({ id: '', text: t })) })),
      skills: x.skills.map((g) => ({ id: '', label: g.label, items: g.items.filter(Boolean) })),
      languages: x.languages.map((l) => ({ id: '', ...l })),
      certifications: x.certifications.map((c) => ({ id: '', ...c })),
      extras: x.extras.map((g) => ({ id: '', title: g.title, items: g.items.filter(Boolean).map((t) => ({ id: '', text: t })) })),
    }),
  );
}

function toExtraction(cv: CvData): CvExtraction {
  return {
    language: cv.language,
    identity: { fullName: cv.identity.fullName, headline: cv.identity.headline, email: cv.identity.email, phone: cv.identity.phone, location: cv.identity.location, linkedin: cv.identity.linkedin, website: cv.identity.website },
    summary: cv.summary,
    experiences: cv.experiences.map((e) => ({ company: e.company, title: e.title, location: e.location, start: e.start, end: e.end, contract: e.contract, summary: e.summary, bullets: e.bullets.map((b) => b.text) })),
    education: cv.education.map((e) => ({ school: e.school, degree: e.degree, field: e.field, location: e.location, start: e.start, end: e.end, details: e.details.map((b) => b.text) })),
    skills: cv.skills.map((g) => ({ label: g.label, items: g.items })),
    languages: cv.languages.map((l) => ({ language: l.language, level: l.level, certification: l.certification })),
    certifications: cv.certifications.map((c) => ({ name: c.name, issuer: c.issuer, date: c.date })),
    extras: cv.extras.map((g) => ({ title: g.title, items: g.items.map((b) => b.text) })),
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
  const source = new Set(tokens(sourceText));
  const out: GroundingWarning[] = [];
  const check = (path: string, value: string) => {
    if (!value || value.length < 3) return;
    const c = coverage(value, source);
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
