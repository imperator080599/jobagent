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
import { getLlm, UNTRUSTED_RULE, wrapUntrusted } from '../llm/index.js';
import { registerMock } from '../llm/mock.js';
import { getActiveAtsPrompt, type AtsPrompt } from '../profile/ats-prompt.js';
import { type CvVersion, getCv } from '../profile/cv.js';
import { ConfigError, NeedsHumanError } from '../core/errors.js';
import { atsDecision, type AtsDecision } from '../shared/stages.js';
import type { Job } from '../tracker/stage.js';
import { assembleAtsPrompt, type IntegrityRecord, PromptIntegrityError, verifyAssembly } from './ats-integrity.js';
import { cvDocument, masterFor } from './brief.js';
import { atsOfferText } from './qualify.js';

export type AtsAnalysis = typeof atsAnalyses.$inferSelect;

// ── Assemblage : voir ats-integrity.ts (remplacement des seules mentions « Copier/coller », preuve par empreintes) ──

/**
 * Cadre technique transmis en consigne système, distinct du prompt de l'utilisateur. Il ne contient
 * aucune règle de notation : il demande une exécution fidèle et rappelle la règle de sécurité sur
 * les données externes (l'offre). Son empreinte est enregistrée avec chaque analyse.
 */
export const ATS_SYSTEM = `Le message qui suit est le prompt personnel d'analyse ATS de l'utilisateur, dans lequel ont été insérés son CV et, le cas échéant, une offre d'emploi. Exécute ce prompt fidèlement, tel qu'il est écrit : même rôle, mêmes items, même barème, même format de restitution. N'en retire rien et n'y ajoute aucun critère.
Le CV est fourni sous forme de texte extrait de son document ; lorsque le fichier PDF est joint, sers-t'en pour apprécier le format et la mise en page réels.
Tu ne disposes d'aucun outil : si le prompt demande de produire un fichier, donne son contenu dans ta réponse, dans une section clairement intitulée.
${UNTRUSTED_RULE}`;

// ── Lecture de la réponse ──

export interface AtsItem {
  label: string;
  score5: number | null;
  improvement: string;
}

export interface AtsParsed {
  /** Note attribuée par le prompt de l'utilisateur. */
  total20: number | null;
  /** Note que le rapport estime atteignable après optimisation (jamais confondue avec la note attribuée). */
  projected20: number | null;
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
export function parseAtsReport(raw: string): { total20: number | null; projected20: number | null; items: AtsItem[]; source: 'report' | 'items' | 'none'; candidates: number[]; confidence: 'row' | 'line' | 'fallback' } {
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
  // Note globale. Un rapport cite souvent plusieurs « x/20 » : la note attribuée, mais aussi celle qu'il
  // prévoit après optimisation. Seule la note attribuée compte.
  const HYPOTHETICAL = /(devrait|pourrait|pourra|viser|objectif|potentiel|atteindr|après (optimisation|correction|intégration)|une fois|optimis[ée]|estim[ée]|projet[ée]|would|could|should|target|expected|after (optimi[sz]|updat|fix))[^.|\n]{0,60}$/i;
  const all = [...raw.matchAll(/(\d{1,2}(?:[.,]\d{1,2})?)\s*\/\s*20\b/g)].map((m) => ({ value: num(m[1]!), index: m.index ?? 0 })).filter((t) => t.value >= 0 && t.value <= 20);
  const candidates = [...new Set(all.map((t) => t.value))];
  const lineStart = (i: number) => raw.lastIndexOf('\n', i) + 1;
  const lineOf = (i: number) => raw.slice(lineStart(i), raw.indexOf('\n', i) === -1 ? raw.length : raw.indexOf('\n', i));
  const hypothetical = (t: { index: number }) => HYPOTHETICAL.test(raw.slice(Math.max(lineStart(t.index), t.index - 90), t.index));
  // Note projetée : une note sur 20 annoncée au conditionnel ou « après optimisation ».
  const projectedHits = all.filter((t) => hypothetical(t));
  const projected20 = projectedHits.length ? projectedHits[projectedHits.length - 1]!.value : null;
  let total: number | null = null;
  let confidence: 'row' | 'line' | 'fallback' = 'fallback';
  // 1. Ligne « TOTAL » d'un tableau : la première cellule qui porte une note sur 20 (« 19,5/30 → 13/20 » donne 13).
  for (const line of lines) {
    if (!line.includes('|')) continue;
    const cells = cellsOf(line);
    if (!cells.some((c) => /^(total|note (globale|finale)|score (global|final)|somme)\b/i.test(c))) continue;
    // La cellule de la note attribuée, jamais celle d'un commentaire de projection.
    const cell = cells.find((c) => /\d\s*\/\s*20\b/.test(c) && !/(devrait|pourrait|après|estim|optimis|would|could|after)/i.test(c));
    const found = cell ? [...cell.matchAll(/(\d{1,2}(?:[.,]\d{1,2})?)\s*\/\s*20\b/g)] : [];
    if (found.length) {
      total = num(found[found.length - 1]![1]!);
      confidence = 'row';
    }
  }
  // 2. Phrase qui annonce la note (« Note globale : 13/20 »), hors formulations au conditionnel.
  if (total == null) {
    const labelled = all.filter((t) => !hypothetical(t) && /(total|note (globale|finale|ajust)|score (global|final|ats)|somme|ajust[ée]e? sur 20)/i.test(lineOf(t.index)));
    if (labelled.length) {
      total = labelled[labelled.length - 1]!.value;
      confidence = 'line';
    }
  }
  // 3. À défaut, la dernière note sur 20 qui n'est pas une projection.
  if (total == null && all.length) total = (all.filter((t) => !hypothetical(t)).pop() ?? all[all.length - 1]!).value;
  if (total != null) return { total20: total, projected20, items, source: 'report', candidates, confidence };
  const scored = items.filter((i) => i.score5 != null);
  if (scored.length >= 3) {
    // « Ajuste la somme des points sur 20 » : somme des notes rapportée au maximum possible.
    const sum = scored.reduce((a, i) => a + (i.score5 ?? 0), 0);
    return { total20: Math.round((sum / (scored.length * 5)) * 200) / 10, projected20, items, source: 'items', candidates, confidence: 'fallback' };
  }
  return { total20: null, projected20, items, source: 'none', candidates, confidence: 'fallback' };
}

const AtsExtract = z.object({
  total20: z.number().min(0).max(20).nullable().describe('Note globale sur 20 ATTRIBUÉE au CV dans le rapport, ou null si elle n\'y est pas. Jamais une note estimée après optimisation.'),
  projected20: z.number().min(0).max(20).nullable().describe('Note sur 20 que le rapport estime atteignable après optimisation, si le rapport en mentionne une ; sinon null.'),
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
    ext = (await llm.json({ purpose: 'ats.extract', tier: 'bulk', system: EXTRACT_SYSTEM, prompt: `<rapport>\n${raw}\n</rapport>`, schema: AtsExtract, maxTokens: 4000, effort: 'low', jobId })).data;
  } catch (err) {
    ctx.log.warn('ats_extract_failed', { error: String(err) });
  }
  // Deux lectures indépendantes de la note : le code, puis le modèle économique. La ligne « TOTAL » du tableau fait foi ;
  // à défaut, si le modèle désigne une autre note qui figure bien dans le rapport, c'est elle qui est retenue.
  // Tout désaccord restant est signalé à l'utilisateur.
  const disagree = det.total20 != null && ext?.total20 != null && Math.abs(det.total20 - ext.total20) > 0.5;
  const trustExtraction = disagree && det.confidence !== 'row' && det.candidates.some((v) => Math.abs(v - ext!.total20!) < 0.05);
  const total20 = trustExtraction ? ext!.total20 : (det.total20 ?? ext?.total20 ?? null);
  // La note recalculée à partir des items sert de troisième témoin.
  const scored = det.items.filter((i) => i.score5 != null);
  const fromItems = scored.length >= 3 ? Math.round((scored.reduce((a, i) => a + (i.score5 ?? 0), 0) / (scored.length * 5)) * 200) / 10 : null;
  const scoreConflict = disagree && !(fromItems != null && total20 != null && Math.abs(fromItems - total20) <= 0.5);
  // Note projetée : lecture du code d'abord ; l'extraction ne la fournit qu'en complément. Elle ne peut jamais devenir la note attribuée.
  const projected20 = det.projected20 ?? ext?.projected20 ?? null;
  return {
    total20,
    projected20: projected20 != null && total20 != null && Math.abs(projected20 - total20) < 0.05 ? null : projected20,
    items: det.items.length >= (ext?.items.length ?? 0) ? det.items : (ext?.items ?? []),
    missingKeywords: [...new Set((ext?.missingKeywords ?? []).map((k) => k.trim()).filter(Boolean))],
    alerts: ext?.alerts ?? [],
    summary: ext?.summary ?? '',
    scoreSource: trustExtraction ? 'extraction' : det.total20 != null ? det.source : ext?.total20 != null ? 'extraction' : 'none',
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

/** Estimation prudente du nombre de jetons (textes en français et en anglais) : on surestime plutôt que de couper. */
const estimateTokens = (chars: number) => Math.ceil(chars / 3);
/** Fenêtre de contexte disponible pour le modèle principal (jetons). */
const CONTEXT_TOKENS = 200_000;
const OUTPUT_TOKENS = [32_000, 64_000];

export async function runAtsAnalysis(ctx: UserContext, input: AtsRunInput): Promise<AtsRunResult> {
  const prompt = await getActiveAtsPrompt(ctx.db, ctx.userId);
  if (!prompt) throw new ConfigError('Aucun prompt ATS actif (Profil → Prompt ATS).', 'ats_prompt_missing');
  const job = input.job;
  const cv = input.cv ?? (await masterFor(ctx, job?.language || undefined));
  // CV : le document lui-même (texte extrait du fichier + PDF joint), sans ajout ni reconstitution.
  const doc = await cvDocument(ctx, cv);
  // Offre : texte complet, encadré comme donnée externe (règle de sécurité), sans annotation ni troncature.
  const offer = job ? wrapUntrusted('offre', atsOfferText(job)) : null;
  const assembled = assembleAtsPrompt(prompt.content, doc.text, offer);
  const check = verifyAssembly(prompt.content, prompt.sha256, assembled);
  if (check.problems.length) {
    await logActivity(ctx.db, { userId: ctx.userId, actor: 'agent:ats', action: 'ats.integrity_failed', level: 'error', summary: `Analyse ATS annulée : ${check.problems.join(' ')}`, entityType: 'job', entityId: job?.id ?? '' });
    throw new PromptIntegrityError(`Intégrité du prompt ATS non garantie : ${check.problems.join(' ')} L'analyse n'a pas été lancée.`);
  }
  // Taille : jamais de troncature silencieuse. Si l'ensemble ne tient pas, l'analyse n'est pas lancée et la raison est donnée.
  const inputTokens = estimateTokens(ATS_SYSTEM.length + assembled.text.length) + (doc.pdf ? doc.pages * 3_000 : 0);
  if (inputTokens + OUTPUT_TOKENS[0]! > CONTEXT_TOKENS) {
    throw new NeedsHumanError(`Le prompt, le CV et l'offre représentent environ ${inputTokens} jetons, au-delà de ce que le modèle peut lire en une fois (${CONTEXT_TOKENS - OUTPUT_TOKENS[0]!} jetons utilisables). Rien n'a été coupé : l'analyse n'est pas lancée. Raccourcissez l'annonce enregistrée ou choisissez un modèle à plus grande fenêtre.`, 'ats_input_too_large', { inputTokens });
  }
  const models = await getSetting(ctx.db, ctx.userId, 'llm.models');
  const requestSha256 = sha256(assembled.text);
  const systemSha256 = sha256(ATS_SYSTEM);
  // Empreinte de tout ce qui influe sur le résultat : une analyse identique n'est jamais payée deux fois.
  const inputHash = sha256([prompt.sha256, requestSha256, systemSha256, doc.pdfSha256 ?? '', models.main].join('|'));
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
  const pdfAttached = Boolean(doc.pdf) && llm.provider !== 'claude-cli';
  let res: Awaited<ReturnType<typeof llm.text>> | null = null;
  let attempts = 0;
  let maxTokens = OUTPUT_TOKENS[0]!;
  // Une sortie interrompue par la limite de longueur est relancée avec une limite plus large ; jamais tronquée en silence.
  for (const budget of OUTPUT_TOKENS) {
    attempts++;
    maxTokens = budget;
    res = await llm.text({ purpose: 'ats.analyze', tier: 'main', system: ATS_SYSTEM, prompt: assembled.text, documents: doc.pdf ? [{ mediaType: 'application/pdf', data: doc.pdf }] : undefined, maxTokens: budget, effort: 'high', jobId: jobId ?? undefined });
    if (res.refused || res.stopReason !== 'max_tokens') break;
  }
  const r = res!;
  const complete = r.stopReason !== 'max_tokens';
  const problems: string[] = [];
  const sentPdf = r.sent?.documents?.find((d) => d.mediaType === 'application/pdf') ?? null;
  const transmitted = r.sent
    ? {
        provider: llm.provider,
        source: r.sent.source,
        sha256: r.sent.sha256,
        chars: r.sent.chars,
        matches: r.sent.sha256 === requestSha256,
        systemMatches: r.sent.systemSha256 == null ? null : r.sent.systemSha256 === systemSha256,
        pdf: sentPdf ? { sha256: sentPdf.sha256, bytes: sentPdf.bytes, matches: sentPdf.sha256 === doc.pdfSha256 } : null,
      }
    : undefined;
  if (transmitted && !transmitted.matches) problems.push('Le texte transmis par le fournisseur diffère du message assemblé.');
  if (transmitted?.systemMatches === false) problems.push('La consigne système transmise diffère de celle prévue.');
  if (transmitted?.pdf && !transmitted.pdf.matches) problems.push('Le PDF transmis ne correspond pas au CV évalué.');
  if (!complete) problems.push(`Le rapport a été interrompu par la limite de longueur (${maxTokens} jetons) après ${attempts} essai(s) : il est conservé mais n'est pas utilisé pour décider.`);
  const integrity: IntegrityRecord = {
    ok: problems.length === 0,
    promptSha256: check.promptSha256,
    promptStoredSha256: prompt.sha256,
    promptChars: prompt.content.length,
    reconstructedSha256: check.reconstructedSha256,
    requestSha256,
    requestChars: assembled.text.length,
    systemSha256,
    insertions: assembled.insertions.map((i) => ({ kind: i.kind, placement: i.placement, replaced: i.replaced, start: i.start, chars: i.end - i.start, sha256: sha256(assembled.text.slice(i.start, i.end)) })),
    cv: { source: doc.source, chars: doc.text.length, sha256: sha256(doc.text), pdfAttached, pdfSha256: doc.pdfSha256 },
    offer: job ? { chars: atsOfferText(job).length, sha256: sha256(atsOfferText(job)), complete: true } : null,
    transmitted,
    output: { sha256: sha256(r.text), chars: r.text.length, stopReason: r.stopReason, complete, maxTokens, attempts },
    problems,
  };
  if (r.refused || !r.text.trim()) {
    if (jobId) {
      await ctx.db.insert(atsAnalyses).values({ id: newId('ats'), userId: ctx.userId, jobId, cvVersionId: cv.id, promptId: prompt.id, promptSha: prompt.sha256, inputHash, model: r.model, rawOutput: r.text, status: 'refused', requestText: assembled.text, integrity: integrity as unknown as Record<string, unknown> });
    }
    throw new Error("Le modèle n'a pas produit d'analyse pour cette offre.");
  }
  // Un texte transmis qui ne correspond pas au message vérifié invalide l'analyse.
  const usable = complete && (!transmitted || (transmitted.matches && transmitted.systemMatches !== false && (!transmitted.pdf || transmitted.pdf.matches)));
  const parsed: AtsParsed = complete ? await extractAtsReport(ctx, r.text, jobId ?? undefined) : { ...parseAtsReport(r.text), missingKeywords: [], alerts: [], summary: '', scoreSource: 'report' as const };
  const thresholds = await getSetting(ctx.db, ctx.userId, 'ats.thresholds');
  const decision = !usable || parsed.total20 == null ? null : atsDecision(parsed.total20, thresholds);
  const status: AtsAnalysis['status'] = usable ? 'ok' : complete ? 'failed' : 'incomplete';
  const meta = { ...parsed, slots: { cv: assembled.insertions.find((i) => i.kind === 'cv')?.placement, offer: assembled.insertions.find((i) => i.kind === 'offer')?.placement ?? 'none' }, pdfAttached, truncated: !complete, costUsd: r.costUsd } as unknown as Record<string, unknown>;
  const values = { userId: ctx.userId, cvVersionId: cv.id, promptId: prompt.id, promptSha: prompt.sha256, inputHash, model: r.model, rawOutput: r.text, parsed: meta, score: usable ? parsed.total20 : null, projectedScore: parsed.projected20, decision: decision ?? '', userNote: input.note ?? '', status, requestText: assembled.text, integrity: integrity as unknown as Record<string, unknown> };
  if (!jobId) {
    // Évaluation du CV seul : rien n'est rattaché à une offre ; le résultat est rendu sans être stocké comme analyse d'offre.
    const analysis = { id: newId('ats'), jobId: '', createdAt: ctx.now(), ...values } as AtsAnalysis;
    return { analysis, parsed, decision, reused: false, prompt, cv };
  }
  const [analysis] = await ctx.db.insert(atsAnalyses).values({ id: newId('ats'), jobId, ...values }).returning();
  await logActivity(ctx.db, {
    userId: ctx.userId,
    actor: 'agent:ats',
    action: usable ? 'ats.analyzed' : 'ats.unusable',
    level: usable ? 'info' : 'warn',
    summary: `${job!.companyName} — ${job!.title} : ${usable ? (parsed.total20 != null ? `${parsed.total20}/20` : 'note non lisible') : problems.join(' ')} (${cv.kind === 'master' ? 'CV master' : 'CV personnalisé'}, prompt v${prompt.version}, empreinte ${prompt.sha256.slice(0, 12)})`,
    entityType: 'job',
    entityId: jobId,
    data: { analysisId: analysis!.id, score: parsed.total20, projected: parsed.projected20, promptVersion: prompt.version, promptSha256: prompt.sha256, requestSha256, cvVersionId: cv.id },
  });
  if (!usable) throw new NeedsHumanError(`Analyse ATS inutilisable : ${problems.join(' ')}`, 'ats_unusable', { analysisId: analysis!.id });
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
  return { total20: det.total20, projected20: det.projected20, items: det.items, missingKeywords: section.split('\n').map((l) => l.replace(/^-\s*/, '').trim()).filter((l) => l && l !== 'Aucun.'), alerts: [], summary: det.total20 != null ? `Note globale ${det.total20}/20.` : '' };
});
