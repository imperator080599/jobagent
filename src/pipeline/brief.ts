// Dossier du candidat transmis aux agents : CV master, informations validées et
// corrections déjà apportées. Tout ce que l'utilisateur a précisé une fois est
// réinjecté ici, pour ne jamais lui reposer la question.
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { UserContext } from '../core/context.js';
import { ConfigError } from '../core/errors.js';
import { getFile } from '../core/files.js';
import { feedback, searchProfiles } from '../db/schema.js';
import { type CvVersion, getCurrentMaster } from '../profile/cv.js';
import { factsMap, listSkillFacts } from '../profile/facts.js';
import { cvToText } from '../shared/cv.js';
import { FACT_BY_KEY, type SkillFact } from '../shared/facts.js';
import { SearchCriteria } from '../shared/search.js';

export interface CandidateBrief {
  master: CvVersion;
  cvText: string;
  /** Compétences confirmées par l'utilisateur en réponse aux questions de l'agent. */
  confirmedSkills: SkillFact[];
  /** Compétences que l'utilisateur a déclaré ne pas maîtriser : à ne jamais lui attribuer. */
  deniedSkills: SkillFact[];
  /** Informations validées utiles au ciblage (mobilité, contrats, motivations…), hors données sensibles. */
  facts: { key: string; label: string; value: string }[];
  /** Corrections de portée générale données par l'utilisateur (« profil »). */
  corrections: string[];
  /** Règles de rédaction (« style »). */
  styleRules: string[];
  criteria: { name: string; criteria: SearchCriteria }[];
  /** Raisons des derniers refus et des dernières offres retenues : préférences apprises. */
  rejections: string[];
}

const TARGETING_PREFIXES = ['eligibility.work_authorization', 'eligibility.sponsorship_needed', 'eligibility.vie_eligible', 'mobility.', 'availability.', 'preferences.contracts', 'preferences.remote', 'background.', 'motivations.'];

function show(v: unknown): string {
  if (Array.isArray(v)) return v.map(show).filter(Boolean).join(', ');
  if (typeof v === 'boolean') return v ? 'oui' : 'non';
  if (v && typeof v === 'object') return JSON.stringify(v);
  return String(v ?? '').trim();
}

/** Master le mieux adapté à la langue de l'offre ; à défaut, le master courant le plus récent. */
export async function masterFor(ctx: UserContext, language?: string): Promise<CvVersion> {
  const master = await getCurrentMaster(ctx.db, ctx.userId, language);
  if (!master) throw new ConfigError('Aucun CV master validé : importez et validez votre CV (Profil → CV).', 'cv_master_missing');
  return master;
}

export async function candidateBrief(ctx: UserContext, opts: { language?: string; master?: CvVersion } = {}): Promise<CandidateBrief> {
  const master = opts.master ?? (await masterFor(ctx, opts.language));
  const [facts, skills, fb, profiles] = await Promise.all([
    factsMap(ctx.db, ctx.userId),
    listSkillFacts(ctx.db, ctx.userId),
    ctx.db
      .select()
      .from(feedback)
      .where(and(eq(feedback.userId, ctx.userId), inArray(feedback.status, ['applied', 'open'])))
      .orderBy(desc(feedback.createdAt))
      .limit(120),
    ctx.db.select().from(searchProfiles).where(and(eq(searchProfiles.userId, ctx.userId), eq(searchProfiles.enabled, true))),
  ]);
  const usable: CandidateBrief['facts'] = [];
  for (const [key, fact] of facts) {
    if (key.startsWith('skill:')) continue;
    const def = FACT_BY_KEY.get(key);
    // Les données sensibles (nationalité, date de naissance, rémunération) ne sont jamais envoyées à un modèle pour noter une offre.
    if (def?.sensitive) continue;
    if (!TARGETING_PREFIXES.some((p) => key.startsWith(p))) continue;
    const value = show(fact.value);
    if (value) usable.push({ key, label: def?.label ?? fact.label ?? key, value });
  }
  const rules = facts.get('writing.rules')?.value;
  return {
    master,
    cvText: cvToText(master.data),
    confirmedSkills: skills.filter((s) => s.has),
    deniedSkills: skills.filter((s) => !s.has),
    facts: usable.sort((a, b) => a.key.localeCompare(b.key)),
    corrections: fb.filter((f) => f.scope === 'profile' && f.kind === 'correction' && f.text.trim()).map((f) => f.text.trim()).slice(0, 30),
    styleRules: Array.isArray(rules) ? (rules as unknown[]).map(String).filter(Boolean) : [],
    criteria: profiles.map((p) => ({ name: p.name, criteria: SearchCriteria.parse(p.config ?? {}) })),
    rejections: fb.filter((f) => f.kind === 'job.reject' && f.text.trim()).map((f) => f.text.trim()).slice(0, 12),
  };
}

/** Corrections propres à une offre (« pour cette candidature, insiste sur… »). */
export async function applicationNotes(ctx: UserContext, jobId: string): Promise<string[]> {
  const rows = await ctx.db
    .select()
    .from(feedback)
    .where(and(eq(feedback.userId, ctx.userId), eq(feedback.jobId, jobId), eq(feedback.scope, 'application'), eq(feedback.kind, 'correction')))
    .orderBy(desc(feedback.createdAt))
    .limit(20);
  return rows.map((r) => r.text.trim()).filter(Boolean).reverse();
}

/** Précisions validées par le candidat, sous forme de texte à joindre à son CV dans un prompt. */
export function clarificationsText(brief: CandidateBrief, extra: string[] = []): string {
  const lines: string[] = [];
  for (const s of brief.confirmedSkills) lines.push(`- ${s.name} : compétence confirmée par le candidat${s.level ? ` (niveau : ${s.level})` : ''}${s.context ? ` — ${s.context}` : ''}`);
  for (const s of brief.deniedSkills) lines.push(`- ${s.name} : non maîtrisé (ne pas le lui attribuer)`);
  for (const c of brief.corrections) lines.push(`- ${c}`);
  for (const c of extra) lines.push(`- ${c}`);
  return lines.join('\n');
}

/** Bloc « profil du candidat » stable (mis en cache d'un appel à l'autre). */
export function profileBlock(brief: CandidateBrief): string {
  const parts = [`<cv_master langue="${brief.master.language}">\n${brief.cvText}\n</cv_master>`];
  const clar = clarificationsText(brief);
  if (clar) parts.push(`<precisions_validees>\n${clar}\n</precisions_validees>`);
  if (brief.facts.length) parts.push(`<informations_validees>\n${brief.facts.map((f) => `- ${f.label} : ${f.value}`).join('\n')}\n</informations_validees>`);
  if (brief.criteria.length) {
    const c = brief.criteria
      .map(({ name, criteria: k }) => {
        const bits = [
          k.titles.length ? `intitulés visés : ${k.titles.join(', ')}` : '',
          k.countries.length ? `pays : ${k.countries.join(', ')}` : '',
          k.cities.length ? `villes : ${k.cities.join(', ')}` : '',
          k.contracts.length ? `contrats : ${k.contracts.join(', ')}` : '',
          k.seniority.length ? `niveaux : ${k.seniority.join(', ')}` : '',
          k.keywords.length ? `mots-clés souhaités : ${k.keywords.join(', ')}` : '',
          k.excludeKeywords.length ? `à éviter : ${k.excludeKeywords.join(', ')}` : '',
        ].filter(Boolean);
        return `- ${name} — ${bits.join(' ; ')}`;
      })
      .join('\n');
    parts.push(`<recherches_en_cours>\n${c}\n</recherches_en_cours>`);
  }
  if (brief.rejections.length) parts.push(`<offres_ecartees_recemment>\nRaisons données par le candidat :\n${brief.rejections.map((r) => `- ${r}`).join('\n')}\n</offres_ecartees_recemment>`);
  return parts.join('\n\n');
}

/** PDF à joindre pour qu'un modèle évalue le format réel du CV : le fichier d'origine d'un master, le PDF généré sinon. */
export async function cvPdf(ctx: UserContext, cv: CvVersion): Promise<Uint8Array | null> {
  const ids = cv.kind === 'master' ? [cv.sourceFileId, cv.pdfFileId] : [cv.pdfFileId];
  for (const id of ids) {
    if (!id) continue;
    const f = await getFile(ctx.db, ctx.userId, id);
    if (f && (f.mime === 'application/pdf' || f.filename.toLowerCase().endsWith('.pdf')) && f.data.byteLength < 4_500_000) return f.data;
  }
  return null;
}
