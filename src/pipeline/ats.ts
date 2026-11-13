// Agent ATS. Il exécute le prompt personnel de l'utilisateur, tel qu'il est
// enregistré : le texte du prompt n'est ni réécrit, ni résumé, ni complété. Seules
// les deux zones « Copier/coller » sont remplies (CV, offre). La réponse du modèle
// est conservée intégralement ; une synthèse structurée en est extraite à part,
// sans jamais s'y substituer.
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { UserContext } from '../core/context.js';
import { logActivity } from '../core/activity.js';
import { sha256 } from '../core/crypto.js';
import { getSetting } from '../core/settings.js';
import { normalize, tokens } from '../core/text.js';
import { newId } from '../db/ids.js';
import { atsAnalyses, jobs } from '../db/schema.js';
import { getLlm, UNTRUSTED_RULE } from '../llm/index.js';
import { registerMock } from '../llm/mock.js';
import { getActiveAtsPrompt, type AtsPrompt } from '../profile/ats-prompt.js';
import { type CvVersion, getCv } from '../profile/cv.js';
import { ConfigError } from '../core/errors.js';
import { cvToText } from '../shared/cv.js';
import { atsDecision, type AtsDecision } from '../shared/stages.js';
import type { Job } from '../tracker/stage.js';
import { applicationNotes, candidateBrief, clarificationsText, cvPdf, masterFor } from './brief.js';
import { jobBlock } from './qualify.js';

export type AtsAnalysis = typeof atsAnalyses.$inferSelect;

// ── Remplissage des zones du prompt ──

const PLACEHOLDER = String.raw`(?:copier\s*\/\s*coller|copier-coller|coller ici|à coller|paste here|copy\s*\/\s*paste|\.{3}|…|\[\s*\.{0,3}\s*\])`;
const CV_LABEL = String.raw`(?:CV|Curriculum vitae|Resume|Résumé)`;
const OFFER_LABEL = String.raw`(?:Offre d[’'‘\`]emploi|Offre|Annonce|Job description|Job offer|Job posting|Fiche de poste)`;

export interface FilledPrompt {
  text: string;
  /** slot = la zone prévue par le prompt a été remplie ; appended = aucune zone trouvée, contenu ajouté à la suite. */
  cv: 'slot' | 'appended';
  offer: 'slot' | 'appended' | 'none';
}

function fillSlot(prompt: string, label: string, token: RegExp, content: string): { text: string; filled: boolean } {
  // 1. Jeton explicite : {{CV}}, [CV], <CV>
  if (token.test(prompt)) return { text: prompt.replace(token, () => content), filled: true };
  // 2. Ligne « ■ CV : Copier/coller » — seule la mention à remplacer change ; le libellé et la puce restent.
  const line = new RegExp(String.raw`^([^\S\n]*[^\w\n]{0,4}[^\S\n]*${label}[^\S\n]*[:：][^\S\n]*)${PLACEHOLDER}[^\S\n]*$`, 'gim');
  let last: RegExpExecArray | null = null;
  for (let m = line.exec(prompt); m; m = line.exec(prompt)) last = m;
  if (last) {
    const start = last.index + last[1]!.length;
    return { text: `${prompt.slice(0, start)}\n${content}${prompt.slice(last.index + last[0].length)}`, filled: true };
  }
  return { text: prompt, filled: false };
}

/**
 * Insère le CV et l'offre dans le prompt de l'utilisateur. Le reste du prompt est
 * restitué caractère pour caractère. Sans offre (évaluation du CV seul), la zone
 * de l'offre indique explicitement qu'aucune offre n'est jointe.
 */
export function fillAtsPrompt(prompt: string, cv: string, offer: string | null): FilledPrompt {
  const a = fillSlot(prompt, CV_LABEL, /\{\{\s*CV\s*\}\}|\[\s*CV\s*\]|<\s*CV\s*>/i, cv);
  let text = a.text;
  const offerContent = offer ?? '(aucune offre jointe : évaluation du CV seul)';
  const b = fillSlot(text, OFFER_LABEL, /\{\{\s*(?:OFFRE|OFFER|JOB|ANNONCE)\s*\}\}|\[\s*(?:OFFRE|OFFER|JOB|ANNONCE)\s*\]|<\s*(?:OFFRE|OFFER|JOB)\s*>/i, offerContent);
  text = b.text;
  if (!a.filled) text = `${text.trimEnd()}\n\n■ CV :\n${cv}`;
  if (!b.filled && offer !== null) text = `${text.trimEnd()}\n\n■ Offre d’emploi :\n${offer}`;
  return { text, cv: a.filled ? 'slot' : 'appended', offer: offer === null ? 'none' : b.filled ? 'slot' : 'appended' };
}

/** Cadre technique minimal. Il ne modifie pas la méthode de l'utilisateur : il fixe la fidélité d'exécution et la règle de sécurité. */
export const ATS_SYSTEM = `Le message qui suit est le prompt personnel d'analyse ATS de l'utilisateur, avec son CV et, le cas échéant, une offre d'emploi. Exécute ce prompt fidèlement, tel qu'il est écrit : même rôle, mêmes items, même barème, même format de restitution. N'en retire rien et n'y ajoute aucun critère.
Le CV est fourni en texte ; lorsque son fichier PDF est joint, sers-t'en pour apprécier le format et la mise en page réels.
Tu ne disposes d'aucun outil : si le prompt demande de produire un fichier, donne son contenu dans ta réponse, dans une section clairement intitulée.
Si des « précisions validées par le candidat » accompagnent le CV, considère-les comme faisant partie de son profil réel.
${UNTRUSTED_RULE}`;

// ── Lecture de la réponse ──

export interface AtsItem {
  label: string;
  score5: number | null;
  improvement: string;
}

export interface AtsParsed {
  total20: number | null;
  items: AtsItem[];
  missingKeywords: string[];
  alerts: string[];
  summary: string;
  /** D'où vient la note retenue : lue dans le rapport, recalculée à partir des items, ou extraite par le modèle. */
  scoreSource: 'report' | 'items' | 'extraction' | 'none';
  /** La note lue dans le rapport et celle de l'extraction divergent : l'utilisateur doit regarder le rapport. */
  scoreConflict?: boolean;
}

const num = (s: string) => Number(s.replace(',', '.'));

const cellsOf = (line: string): string[] => {
  const cells = line.split('|').map((c) => c.replace(/\*\*/g, '').trim());
  if (cells[0] === '') cells.shift();
  if (cells[cells.length - 1] === '') cells.pop();
  return cells;
};

/** Lecture déterministe : tableau d'items notés sur 5 et note globale sur 20. */
export function parseAtsReport(raw: string): { total20: number | null; items: AtsItem[]; source: 'report' | 'items' | 'none' } {
  const items: AtsItem[] = [];
  const lines = raw.split('\n');
  // Colonnes du tableau en cours : la note peut être écrite « 4/5 » dans la cellule, ou « 4 » sous un en-tête « Note /5 ».
  let scoreCol = -1;
  let labelCol = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.includes('|')) {
      scoreCol = -1;
      labelCol = -1;
      continue;
    }
    const cells = cellsOf(line);
    if (cells.length < 2 || cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    if (lines[i + 1] && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) {
      scoreCol = cells.findIndex((c) => /\/\s*5\b/.test(c) || /^(note|score|notation)\b/i.test(c));
      labelCol = cells.findIndex((c) => /^(item|crit[èe]re|élément|element|rubrique)/i.test(c));
      continue;
    }
    let idx = cells.findIndex((c) => /^(\d(?:[.,]\d{1,2})?)\s*\/\s*5\b/.test(c));
    if (idx < 0 && scoreCol >= 0 && /^\d(?:[.,]\d{1,2})?(?!\d)(?!\s*\/\s*(?:[0-46-9]|\d\d))/.test(cells[scoreCol] ?? '')) idx = scoreCol;
    if (idx <= 0) continue;
    const score = num(/^(\d(?:[.,]\d{1,2})?)/.exec(cells[idx]!)![1]!);
    if (score > 5) continue;
    const before = cells.slice(0, idx).filter((c) => c && !/^\d{1,2}[.)]?$/.test(c));
    const label = (labelCol >= 0 && labelCol < idx && cells[labelCol] ? cells[labelCol]! : before.join(' — ')).trim();
    if (!label || /^(total|somme|note globale|note finale|score)/i.test(label)) continue;
    items.push({ label, score5: score, improvement: (cells[cells.length - 1] === cells[idx] ? '' : cells.slice(idx + 1).pop() ?? '').trim() });
  }
  const totals = [...raw.matchAll(/(\d{1,2}(?:[.,]\d{1,2})?)\s*\/\s*20\b/g)].map((m) => ({ value: num(m[1]!), index: m.index ?? 0 })).filter((t) => t.value >= 0 && t.value <= 20);
  let total: number | null = null;
  if (totals.length) {
    const lineOf = (i: number) => raw.slice(raw.lastIndexOf('\n', i) + 1, raw.indexOf('\n', i) === -1 ? raw.length : raw.indexOf('\n', i));
    const labelled = totals.filter((t) => /(total|note (globale|finale|ajust)|score (global|final|ats)|somme|ajust[ée]e? sur 20|sur 20)/i.test(lineOf(t.index)));
    total = (labelled.length ? labelled[labelled.length - 1]! : totals[totals.length - 1]!).value;
  }
  if (total != null) return { total20: total, items, source: 'report' };
  const scored = items.filter((i) => i.score5 != null);
  if (scored.length >= 3) {
    // « Ajuste la somme des points sur 20 » : somme des notes rapportée au maximum possible.
    const sum = scored.reduce((a, i) => a + (i.score5 ?? 0), 0);
    return { total20: Math.round((sum / (scored.length * 5)) * 200) / 10, items, source: 'items' };
  }
  return { total20: null, items, source: 'none' };
}

const AtsExtract = z.object({
  total20: z.number().min(0).max(20).nullable().describe('Note globale sur 20 telle qu\'elle figure dans le rapport, ou null si elle n\'y est pas.'),
  items: z.array(z.object({ label: z.string(), score5: z.number().min(0).max(5).nullable(), improvement: z.string() })).describe('Items évalués, dans l\'ordre du rapport.'),
  missingKeywords: z.array(z.string()).max(60).describe('Mots-clés que le rapport signale comme absents du CV.'),
  alerts: z.array(z.string()).max(10).describe('Alertes de lisibilité ou de format signalées par le rapport.'),
  summary: z.string().describe('Deux phrases au plus : la conclusion du rapport.'),
});

const EXTRACT_SYSTEM = `Tu extrais les données d'un rapport d'analyse ATS déjà rédigé. Tu ne juges rien, tu ne corriges rien et tu n'ajoutes rien : tu recopies les notes, les mots-clés manquants et les alertes tels qu'ils figurent dans le rapport. Si une information n'y est pas, rends une liste vide ou null.`;

export async function extractAtsReport(ctx: UserContext, raw: string, jobId?: string): Promise<AtsParsed> {
  const det = parseAtsReport(raw);
  let ext: z.infer<typeof AtsExtract> | null = null;
  try {
    const llm = await getLlm(ctx);
    ext = (await llm.json({ purpose: 'ats.extract', tier: 'bulk', system: EXTRACT_SYSTEM, prompt: `<rapport>\n${raw.slice(0, 40_000)}\n</rapport>`, schema: AtsExtract, maxTokens: 3000, effort: 'low', jobId })).data;
  } catch (err) {
    ctx.log.warn('ats_extract_failed', { error: String(err) });
  }
  const total20 = det.total20 ?? ext?.total20 ?? null;
  const scoreConflict = det.total20 != null && ext?.total20 != null && Math.abs(det.total20 - ext.total20) > 0.5;
  return {
    total20,
    items: det.items.length >= (ext?.items.length ?? 0) ? det.items : (ext?.items ?? []),
    missingKeywords: [...new Set((ext?.missingKeywords ?? []).map((k) => k.trim()).filter(Boolean))],
    alerts: ext?.alerts ?? [],
    summary: ext?.summary ?? '',
    scoreSource: det.total20 != null ? det.source : ext?.total20 != null ? 'extraction' : 'none',
    ...(scoreConflict ? { scoreConflict: true } : {}),
  };
}

// ── Exécution ──

export interface AtsRunInput {
  job: Job | null;
  /** Version de CV à évaluer ; par défaut le master adapté à la langue de l'offre. */
  cv?: CvVersion;
  /** Précisions propres à cette analyse (en plus de celles déjà validées). */
  note?: string;
  /** Relance explicite : ne pas réutiliser une analyse identique déjà enregistrée. */
  force?: boolean;
}

export interface AtsRunResult {
  analysis: AtsAnalysis;
  parsed: AtsParsed;
  decision: AtsDecision | null;
  reused: boolean;
  prompt: AtsPrompt;
  cv: CvVersion;
}

export async function runAtsAnalysis(ctx: UserContext, input: AtsRunInput): Promise<AtsRunResult> {
  const prompt = await getActiveAtsPrompt(ctx.db, ctx.userId);
  if (!prompt) throw new ConfigError('Aucun prompt ATS actif (Profil → Prompt ATS).', 'ats_prompt_missing');
  const job = input.job;
  const cv = input.cv ?? (await masterFor(ctx, job?.language || undefined));
  const brief = await candidateBrief(ctx, { master: cv.kind === 'master' ? cv : undefined, language: cv.language });
  const notes = job ? await applicationNotes(ctx, job.id) : [];
  if (input.note?.trim()) notes.push(input.note.trim());
  const clarifications = clarificationsText(brief, notes);
  const cvBlock = `${cvToText(cv.data)}${clarifications ? `\n\nPrécisions validées par le candidat (à considérer comme faisant partie de son profil réel) :\n${clarifications}` : ''}`;
  const filled = fillAtsPrompt(prompt.content, cvBlock, job ? jobBlock(job, 30_000) : null);
  const models = await getSetting(ctx.db, ctx.userId, 'llm.models');
  // Empreinte de tout ce qui influe sur le résultat : une analyse identique n'est jamais payée deux fois.
  const inputHash = sha256([prompt.sha256, sha256(cvBlock), job ? `${job.id}:${job.descriptionHash}:${sha256(job.title + job.companyName)}` : 'cv-only', models.main, ATS_SYSTEM.length].join('|'));
  const jobId = job?.id ?? null;
  if (!input.force && jobId) {
    const [prev] = await ctx.db
      .select()
      .from(atsAnalyses)
      .where(and(eq(atsAnalyses.userId, ctx.userId), eq(atsAnalyses.inputHash, inputHash), eq(atsAnalyses.status, 'ok')))
      .orderBy(desc(atsAnalyses.createdAt))
      .limit(1);
    if (prev) {
      const parsed = prev.parsed as unknown as AtsParsed;
      return { analysis: prev, parsed, decision: (prev.decision as AtsDecision) || null, reused: true, prompt, cv };
    }
  }
  const llm = await getLlm(ctx);
  const pdf = await cvPdf(ctx, cv);
  const res = await llm.text({ purpose: 'ats.analyze', tier: 'main', system: ATS_SYSTEM, prompt: filled.text, documents: pdf ? [{ mediaType: 'application/pdf', data: pdf }] : undefined, maxTokens: 24_000, effort: 'high', jobId: jobId ?? undefined });
  if (res.refused || !res.text.trim()) {
    if (jobId) {
      await ctx.db.insert(atsAnalyses).values({ id: newId('ats'), userId: ctx.userId, jobId, cvVersionId: cv.id, promptId: prompt.id, promptSha: prompt.sha256, inputHash, model: res.model, rawOutput: res.text, status: 'refused' });
    }
    throw new Error("Le modèle n'a pas produit d'analyse pour cette offre.");
  }
  const parsed = await extractAtsReport(ctx, res.text, jobId ?? undefined);
  const thresholds = await getSetting(ctx.db, ctx.userId, 'ats.thresholds');
  const decision = parsed.total20 == null ? null : atsDecision(parsed.total20, thresholds);
  const meta = { ...parsed, slots: { cv: filled.cv, offer: filled.offer }, pdfAttached: Boolean(pdf) && llm.provider !== 'claude-cli', truncated: res.stopReason === 'max_tokens', costUsd: res.costUsd } as unknown as Record<string, unknown>;
  if (!jobId) {
    // Évaluation du CV seul : rien n'est rattaché à une offre ; le résultat est rendu sans être stocké comme analyse d'offre.
    const analysis = { id: newId('ats'), userId: ctx.userId, jobId: '', cvVersionId: cv.id, promptId: prompt.id, promptSha: prompt.sha256, inputHash, model: res.model, rawOutput: res.text, parsed: meta, score: parsed.total20, decision: decision ?? '', userNote: input.note ?? '', status: 'ok' as const, createdAt: ctx.now() };
    return { analysis, parsed, decision, reused: false, prompt, cv };
  }
  const [analysis] = await ctx.db
    .insert(atsAnalyses)
    .values({ id: newId('ats'), userId: ctx.userId, jobId, cvVersionId: cv.id, promptId: prompt.id, promptSha: prompt.sha256, inputHash, model: res.model, rawOutput: res.text, parsed: meta, score: parsed.total20, decision: decision ?? '', userNote: input.note ?? '', status: 'ok' })
    .returning();
  await logActivity(ctx.db, { userId: ctx.userId, actor: 'agent:ats', action: 'ats.analyzed', summary: `${job!.companyName} — ${job!.title} : ${parsed.total20 != null ? `${parsed.total20}/20` : 'note non lisible'} (${cv.kind === 'master' ? 'CV master' : 'CV personnalisé'}, prompt v${prompt.version})`, entityType: 'job', entityId: jobId, data: { analysisId: analysis!.id, score: parsed.total20, promptVersion: prompt.version, cvVersionId: cv.id } });
  return { analysis: analysis!, parsed, decision, reused: false, prompt, cv };
}

/** Reporte sur la fiche de l'offre le résultat de l'analyse de référence (celle du CV master). */
export async function recordAtsOnJob(ctx: UserContext, job: Job, r: AtsRunResult): Promise<void> {
  await ctx.db
    .update(jobs)
    .set({ atsScore: r.parsed.total20, atsDecision: r.decision ?? '', latestAnalysisId: r.analysis.id, updatedAt: ctx.now() })
    .where(and(eq(jobs.id, job.id), eq(jobs.userId, ctx.userId)));
}

export async function latestAnalysis(ctx: UserContext, jobId: string, cvVersionId?: string): Promise<AtsAnalysis | null> {
  const conds = [eq(atsAnalyses.userId, ctx.userId), eq(atsAnalyses.jobId, jobId), eq(atsAnalyses.status, 'ok')];
  if (cvVersionId) conds.push(eq(atsAnalyses.cvVersionId, cvVersionId));
  const [row] = await ctx.db.select().from(atsAnalyses).where(and(...conds)).orderBy(desc(atsAnalyses.createdAt)).limit(1);
  return row ?? null;
}

export async function analysisCv(ctx: UserContext, a: AtsAnalysis): Promise<CvVersion | null> {
  try {
    return await getCv(ctx.db, ctx.userId, a.cvVersionId);
  } catch {
    return null;
  }
}

// ── Simulation (tests, démonstration) ──
// Produit un rapport au format demandé par le prompt (tableau noté sur 5, somme ajustée sur 20),
// à partir du vocabulaire commun entre le CV et l'offre.

const KEYWORD_STOP = new Set(['notre', 'votre', 'vous', 'nous', 'with', 'will', 'your', 'team', 'poste', 'profil', 'missions', 'about', 'role', 'pour', 'dans', 'avec', 'that', 'this', 'have', 'from', 'etre', 'sont', 'plus', 'entreprise', 'intitule', 'lieu', 'contrat', 'detecte', 'experience', 'years', 'annees']);

export function mockKeywords(offer: string, max = 12): string[] {
  const counts = new Map<string, number>();
  for (const t of tokens(offer)) {
    if (t.length < 5 || KEYWORD_STOP.has(t) || /^\d/.test(t)) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([t]) => t);
}

registerMock('ats.analyze', (req) => {
  const cvPart = /■ CV\s*:[^\S\n]*\n([\s\S]*?)(?=\n[^\n]*Offre d[’']emploi\s*:|\n<donnees_non_fiables|$)/.exec(req.prompt)?.[1] ?? req.prompt;
  const offer = /<donnees_non_fiables[^>]*>\n([\s\S]*)\n<\/donnees_non_fiables>/.exec(req.prompt)?.[1] ?? '';
  const cv = normalize(cvPart);
  const kws = mockKeywords(offer);
  const missing = kws.filter((k) => !cv.includes(k));
  const present = kws.length - missing.length;
  const kwScore = kws.length ? Math.round((present / kws.length) * 50) / 10 : 3;
  const rows: [string, number, string][] = [
    ['Présence d’un titre clair et lisible', 4, 'Reprendre l’intitulé exact du poste visé.'],
    ['Format du CV', req.documents?.length ? 5 : 4, req.documents?.length ? 'PDF textuel : rien à signaler.' : 'Fournir le CV en PDF textuel.'],
    ['Structure du CV', 4, 'Titres de section clairs.'],
    ['Mots-clés du poste', kwScore, missing.length ? `Intégrer : ${missing.join(', ')}.` : 'Tous les mots-clés principaux sont présents.'],
    ['Images et abréviations', 4, 'Développer les abréviations à la première occurrence.'],
    ['Éléments illisibles (tableaux, zones de texte)', 5, 'Aucun élément bloquant détecté.'],
  ];
  const sum = rows.reduce((a, r) => a + r[1], 0);
  const total = Math.round((sum / (rows.length * 5)) * 200) / 10;
  return [
    offer ? '## Évaluation du CV en fonction de l’offre' : '## Évaluation du CV seul',
    '',
    '| Item | Note | Point d’amélioration |',
    '|---|---|---|',
    ...rows.map((r) => `| ${r[0]} | ${String(r[1]).replace('.', ',')}/5 | ${r[2]} |`),
    '',
    `**Note globale ajustée : ${String(total).replace('.', ',')}/20**`,
    '',
    '### Mots-clés manquants',
    missing.length ? missing.map((m) => `- ${m}`).join('\n') : 'Aucun.',
  ].join('\n');
});

registerMock('ats.extract', (req) => {
  const raw = /<rapport>\n([\s\S]*)\n<\/rapport>/.exec(req.prompt)?.[1] ?? '';
  const det = parseAtsReport(raw);
  const section = /### Mots-clés manquants\n([\s\S]*)$/.exec(raw)?.[1] ?? '';
  return { total20: det.total20, items: det.items, missingKeywords: section.split('\n').map((l) => l.replace(/^-\s*/, '').trim()).filter((l) => l && l !== 'Aucun.'), alerts: [], summary: det.total20 != null ? `Note globale ${det.total20}/20.` : '' };
});
