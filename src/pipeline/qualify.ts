// Qualification d'une offre : deux notes distinctes et une priorité.
//  - pertinence : intérêt de l'opportunité pour la carrière (indépendant des chances) ;
//  - adéquation : correspondance du profil réel avec les exigences ;
//  - priorité   : combinaison pondérée, réglable dans les paramètres.
// Les filtres durs (contrat, pays, mots exclus, entreprise exclue) sont du code ;
// l'appréciation fine est confiée au modèle économique. Une offre écartée reste
// visible dans « Écartées », avec sa raison, et peut être rétablie.
import { and, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { UserContext } from '../core/context.js';
import { logActivity } from '../core/activity.js';
import { enqueue } from '../core/queue.js';
import { getSetting } from '../core/settings.js';
import { coverage, normalize, tokens, tokenSimilarity } from '../core/text.js';
import { atsAnalyses, companies, jobs } from '../db/schema.js';
import { detectInjection, getLlm, llmAvailability, UNTRUSTED_RULE, wrapUntrusted, type InjectionFinding } from '../llm/index.js';
import { registerMock } from '../llm/mock.js';
import { CONTRACT_LABELS, type SearchCriteria } from '../shared/search.js';
import { getJob, setStage, type Job } from '../tracker/stage.js';
import { candidateBrief, profileBlock, type CandidateBrief } from './brief.js';

export interface RuleVerdict {
  /** Recherche (profil de critères) à laquelle l'offre correspond le mieux. */
  profile: string | null;
  /** Écartée par une règle explicite de l'utilisateur. */
  excluded: boolean;
  reasons: string[];
  /** Réserves qui n'écartent pas l'offre mais pèsent sur la note. */
  warnings: string[];
  /** Proximité de l'intitulé avec les intitulés visés (0..1) ; null si aucun intitulé n'est défini. */
  titleMatch: number | null;
}

const wordIn = (needle: string, hay: string) => new RegExp(`(^| )${normalize(needle).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(hay);

function titleProximity(title: string, targets: string[]): number {
  let best = 0;
  const t = new Set(tokens(title));
  for (const target of targets) {
    best = Math.max(best, tokenSimilarity(title, target), coverage(target, t) * 0.95);
  }
  return Math.round(best * 100) / 100;
}

/** Applique les critères d'une recherche à une offre. Purement déterministe. */
export function applyCriteria(job: Pick<Job, 'title' | 'country' | 'city' | 'remote' | 'contractType' | 'seniority' | 'yearsMin' | 'language' | 'postedAt' | 'descriptionText'>, c: SearchCriteria, now: Date): Omit<RuleVerdict, 'profile'> {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const title = normalize(job.title);
  const hit = c.excludeKeywords.find((k) => wordIn(k, title));
  if (hit) reasons.push(`l'intitulé contient « ${hit} », que vous avez exclu`);
  if (c.contracts.length && job.contractType && !c.contracts.includes(job.contractType as (typeof c.contracts)[number])) {
    reasons.push(`contrat ${CONTRACT_LABELS[job.contractType as keyof typeof CONTRACT_LABELS] ?? job.contractType} hors de vos critères`);
  }
  if (c.countries.length && job.country && !c.countries.map((x) => x.toUpperCase()).includes(job.country)) {
    if (!(c.remoteAnywhere && job.remote === 'remote')) reasons.push(`pays (${job.country}) hors de vos critères`);
  }
  if (c.languages.length && job.language && !c.languages.includes(job.language)) reasons.push(`annonce rédigée en ${job.language.toUpperCase()}, langue non retenue`);
  if (c.maxYearsRequired != null && job.yearsMin != null && job.yearsMin > c.maxYearsRequired) reasons.push(`${job.yearsMin} ans d'expérience exigés (votre limite : ${c.maxYearsRequired})`);
  if (c.seniority.length && job.seniority && !c.seniority.includes(job.seniority as (typeof c.seniority)[number])) warnings.push(`niveau « ${job.seniority} » en dehors des niveaux visés`);
  if (c.cities.length && job.city && !c.cities.some((x) => normalize(x) === normalize(job.city)) && job.remote !== 'remote') warnings.push(`ville (${job.city}) différente de vos villes visées`);
  if (job.postedAt && now.getTime() - job.postedAt.getTime() > c.maxAgeDays * 86400_000) warnings.push(`annonce publiée il y a plus de ${c.maxAgeDays} jours`);
  const titleMatch = c.titles.length ? titleProximity(job.title, c.titles) : null;
  return { excluded: reasons.length > 0, reasons, warnings, titleMatch };
}

/** Meilleure correspondance parmi les recherches actives. Sans recherche définie, aucune règle ne s'applique. */
export function ruleVerdict(job: Parameters<typeof applyCriteria>[0], brief: Pick<CandidateBrief, 'criteria'>, now: Date): RuleVerdict {
  if (!brief.criteria.length) return { profile: null, excluded: false, reasons: [], warnings: [], titleMatch: null };
  const all = brief.criteria.map((p) => ({ profile: p.name, ...applyCriteria(job, p.criteria, now) }));
  const passing = all.filter((v) => !v.excluded).sort((a, b) => (b.titleMatch ?? 0) - (a.titleMatch ?? 0) || a.warnings.length - b.warnings.length);
  // Écartée seulement si AUCUNE recherche ne l'accepte.
  return passing[0] ?? all.sort((a, b) => a.reasons.length - b.reasons.length)[0]!;
}

const QualifyOut = z.object({
  relevance: z.number().min(0).max(100).describe("Pertinence : intérêt de l'opportunité pour la carrière du candidat, de 0 à 100."),
  fit: z.number().min(0).max(100).describe('Adéquation : correspondance du profil réel avec les exigences, de 0 à 100.'),
  strategic: z.boolean().describe("Vrai si l'offre mérite un examen même avec une adéquation modeste."),
  summary: z.string().describe('Deux phrases au plus : ce qui rend cette offre intéressante ou non pour ce candidat.'),
  strengths: z.array(z.string()).max(5).describe('Atouts réels du candidat pour ce poste, tirés de son CV.'),
  gaps: z.array(z.string()).max(5).describe("Exigences de l'annonce que le CV ne couvre pas."),
  blockers: z.array(z.string()).max(4).describe('Points potentiellement bloquants (langue exigée, autorisation de travail, diplôme imposé, années requises).'),
});
export type QualifyOut = z.infer<typeof QualifyOut>;

const SYSTEM = `Tu évalues des offres d'emploi pour un candidat précis. Tu rends deux notes indépendantes, de 0 à 100.

1. pertinence — l'intérêt de l'opportunité pour sa carrière : métier et missions par rapport à ce qu'il vise, secteur, entreprise, lieu, niveau du poste, type de contrat, perspectives. Ne tiens PAS compte de ses chances d'être retenu.
2. adequation — la correspondance entre son profil réel et les exigences de l'annonce : expériences, compétences, outils, diplômes, langues, années d'expérience demandées. Ne tiens PAS compte de l'attrait du poste.

Repères communs : 85-100 cœur de cible ou exigences toutes couvertes ; 65-84 solide ; 45-64 mitigé ; 25-44 faible ; 0-24 hors sujet.
Une offre peut être très pertinente et peu adéquate (poste visé mais exigences non couvertes), ou l'inverse : les deux notes ne doivent pas se copier.
« strategic » est vrai lorsque l'offre mérite d'être examinée malgré une adéquation modeste : poste tremplin clairement aligné avec l'objectif du candidat, ou entreprise qu'il vise.

Règles : appuie-toi uniquement sur le dossier fourni ; n'attribue au candidat aucune compétence, expérience ou langue qui n'y figure pas ; tiens compte des précisions qu'il a validées et des raisons pour lesquelles il a écarté d'autres offres. Sois bref, factuel, en français.
${UNTRUSTED_RULE}`;

export function jobBlock(job: Pick<Job, 'title' | 'companyName' | 'locationRaw' | 'contractType' | 'seniority' | 'yearsMin' | 'yearsMax' | 'remote' | 'descriptionText'>, maxChars = 14_000): string {
  const meta = [
    `Intitulé : ${job.title}`,
    `Entreprise : ${job.companyName}`,
    job.locationRaw ? `Lieu : ${job.locationRaw}` : '',
    job.contractType ? `Contrat (détecté) : ${CONTRACT_LABELS[job.contractType as keyof typeof CONTRACT_LABELS] ?? job.contractType}` : '',
    job.remote ? `Mode de travail (détecté) : ${job.remote}` : '',
    job.yearsMin != null ? `Expérience demandée (détectée) : ${job.yearsMin}${job.yearsMax != null ? ` à ${job.yearsMax}` : '+'} ans` : '',
  ].filter(Boolean);
  return wrapUntrusted('offre', `${meta.join('\n')}\n\n${job.descriptionText.slice(0, maxChars)}`);
}

export interface Qualification extends QualifyOut {
  priority: number;
  method: 'llm' | 'rules';
  rules: RuleVerdict;
  injection: InjectionFinding[];
  companyTier: string;
}

/** Notation de secours, sans IA : proximité de l'intitulé et recouvrement des termes du CV. Indicative. */
export function rulesOnlyScores(job: Pick<Job, 'title' | 'descriptionText'>, brief: Pick<CandidateBrief, 'cvText'>, rules: RuleVerdict): QualifyOut {
  const cv = new Set(tokens(brief.cvText));
  const need = [...new Set(tokens(`${job.title} ${job.descriptionText.slice(0, 6000)}`))].filter((t) => t.length > 3);
  const covered = need.filter((t) => cv.has(t)).length;
  const fit = need.length ? Math.round(Math.min(1, (covered / need.length) * 2.2) * 100) : 50;
  const relevance = rules.titleMatch == null ? 55 : Math.round(30 + rules.titleMatch * 65 - rules.warnings.length * 5);
  return {
    relevance: Math.max(0, Math.min(100, relevance)),
    fit,
    strategic: false,
    summary: "Notation indicative établie sans IA (proximité de l'intitulé et vocabulaire commun avec votre CV).",
    strengths: [],
    gaps: [],
    blockers: [],
  };
}

export function freshness(job: Pick<Job, 'postedAt' | 'firstSeenAt'>, now: Date): number {
  const ref = job.postedAt ?? job.firstSeenAt;
  const days = Math.max(0, (now.getTime() - ref.getTime()) / 86400_000);
  return Math.round(Math.max(0, 100 - days * 2.5));
}

export function priorityScore(q: { relevance: number; fit: number; strategic: boolean }, fresh: number, weights: { relevance: number; fit: number; freshness: number }, tier: string, deadlineAt: Date | null, now: Date): number {
  const total = weights.relevance + weights.fit + weights.freshness || 1;
  let p = (q.relevance * weights.relevance + q.fit * weights.fit + fresh * weights.freshness) / total;
  if (tier === 'dream') p += 10;
  else if (tier === 'target') p += 5;
  if (q.strategic) p += 5;
  // Une date limite proche fait remonter l'offre.
  if (deadlineAt) {
    const days = (deadlineAt.getTime() - now.getTime()) / 86400_000;
    if (days >= 0 && days <= 7) p += 8;
  }
  return Math.round(Math.max(0, Math.min(100, p)));
}

async function companyTier(ctx: UserContext, job: Job): Promise<string> {
  const [co] = await ctx.db.select({ tier: companies.tier }).from(companies).where(and(eq(companies.userId, ctx.userId), eq(companies.nameNorm, job.companyNorm)));
  return co?.tier ?? '';
}

export async function qualifyJob(ctx: UserContext, job: Job, brief?: CandidateBrief): Promise<Qualification> {
  const b = brief ?? (await candidateBrief(ctx, { language: job.language || undefined }));
  const now = ctx.now();
  const rules = ruleVerdict(job, b, now);
  const tier = await companyTier(ctx, job);
  const injection = detectInjection(`${job.title}\n${job.descriptionText}`);
  let scores: QualifyOut;
  let method: Qualification['method'] = 'rules';
  if (rules.excluded || tier === 'excluded' || !(await llmAvailability(ctx)).available || job.descriptionText.length < 200) {
    scores = rulesOnlyScores(job, b, rules);
    if (job.descriptionText.length < 200) scores.summary = "Annonce trop courte pour une évaluation fiable : complétez son texte pour l'analyser.";
  } else {
    const llm = await getLlm(ctx);
    const res = await llm.json({ purpose: 'job.qualify', tier: 'bulk', system: SYSTEM, prefix: `Dossier du candidat :\n\n${profileBlock(b)}`, prompt: `Offre à évaluer :\n\n${jobBlock(job)}`, schema: QualifyOut, maxTokens: 900, effort: 'low', jobId: job.id });
    scores = res.data;
    method = 'llm';
  }
  const weights = await getSetting(ctx.db, ctx.userId, 'scoring.weights');
  const priority = priorityScore(scores, freshness(job, now), weights, tier, job.deadlineAt, now);
  return { ...scores, relevance: Math.round(scores.relevance), fit: Math.round(scores.fit), priority, method, rules, injection, companyTier: tier };
}

/** Nombre d'analyses ATS déjà réalisées aujourd'hui (plafond de coût). */
export async function atsRunsToday(ctx: UserContext): Promise<number> {
  const now = ctx.now();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(atsAnalyses)
    .where(and(eq(atsAnalyses.userId, ctx.userId), gte(atsAnalyses.createdAt, dayStart)));
  return row?.n ?? 0;
}

export interface QualifyOutcome {
  jobId: string;
  decision: 'analyze' | 'filtered' | 'skipped';
  reason: string;
  qualification?: Qualification;
}

/**
 * Tâche « job.qualify ». Une offre ajoutée à la main n'est jamais écartée : l'utilisateur
 * l'a choisie. Une offre « stratégique » ou d'une entreprise ciblée n'est jamais masquée
 * par le seuil de pertinence.
 */
export async function runQualification(ctx: UserContext, jobId: string, opts: { manual?: boolean } = {}): Promise<QualifyOutcome> {
  const job = await getJob(ctx, jobId);
  if (job.stage !== 'new' && job.stage !== 'to_analyze') return { jobId, decision: 'skipped', reason: `statut ${job.stage}` };
  const q = await qualifyJob(ctx, job);
  const policy = await getSetting(ctx.db, ctx.userId, 'ats.policy');
  const patch = {
    relevanceScore: q.relevance,
    fitScore: q.fit,
    priorityScore: q.priority,
    strategic: q.strategic,
    qualification: { summary: q.summary, strengths: q.strengths, gaps: q.gaps, blockers: q.blockers, rules: q.rules, companyTier: q.companyTier } as Record<string, unknown>,
    qualifiedAt: ctx.now(),
    qualificationMethod: q.method,
    flags: q.injection.length ? { ...job.flags, injection: q.injection } : job.flags,
  };
  let reason = '';
  if (!opts.manual) {
    if (q.companyTier === 'excluded') reason = `${job.companyName} fait partie des entreprises que vous avez exclues`;
    else if (q.rules.excluded) reason = q.rules.reasons.join(' ; ');
    else if (q.relevance < policy.minRelevance && !q.strategic && q.companyTier !== 'dream' && q.companyTier !== 'target') reason = `pertinence ${q.relevance}/100, sous votre seuil de ${policy.minRelevance}`;
  }
  if (reason) {
    await setStage(ctx, job.id, 'filtered', { actor: 'agent:qualification', reason, patch });
    return { jobId, decision: 'filtered', reason, qualification: q };
  }
  await setStage(ctx, job.id, 'to_analyze', { actor: 'agent:qualification', reason: q.method === 'llm' ? `pertinence ${q.relevance}, adéquation ${q.fit}` : 'notation sans IA', patch });
  if (q.injection.length) {
    await logActivity(ctx.db, { userId: ctx.userId, actor: 'agent:qualification', action: 'job.injection_suspected', level: 'warn', summary: `${job.companyName} — ${job.title} : l'annonce contient un texte qui s'adresse à une IA. Elle sera traitée comme une simple donnée et aucune action automatique ne sera prise pour elle.`, entityType: 'job', entityId: job.id, data: { findings: q.injection } });
  }
  // Plafond quotidien : au-delà, l'analyse est reportée au lendemain (les offres prioritaires passent d'abord).
  const used = await atsRunsToday(ctx);
  const now = ctx.now();
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5));
  const deferred = policy.maxPerDay > 0 && used >= policy.maxPerDay && !opts.manual;
  await enqueue(ctx.db, { type: 'job.ats', userId: ctx.userId, payload: { jobId: job.id, manual: Boolean(opts.manual) }, idempotencyKey: `job.ats:${job.id}`, priority: opts.manual ? 85 : Math.max(10, Math.min(79, q.priority)), runAfter: deferred ? tomorrow : now });
  return { jobId, decision: 'analyze', reason: deferred ? 'analyse ATS reportée (plafond quotidien atteint)' : '', qualification: q };
}

// Simulation (tests, démonstration) : notes déduites du vocabulaire commun entre le CV et l'offre.
registerMock('job.qualify', (req) => {
  const cv = /<cv_master[^>]*>\n([\s\S]*?)\n<\/cv_master>/.exec(req.prefix ?? '')?.[1] ?? '';
  const offer = /<donnees_non_fiables[^>]*>\n([\s\S]*)\n<\/donnees_non_fiables>/.exec(req.prompt)?.[1] ?? '';
  const targets = /intitulés visés : ([^;\n]+)/.exec(req.prefix ?? '')?.[1]?.split(',').map((s) => s.trim()) ?? [];
  const title = /Intitulé : (.*)/.exec(offer)?.[1] ?? '';
  const cvTokens = new Set(tokens(cv));
  const need = [...new Set(tokens(offer))].filter((t) => t.length > 4);
  const fit = need.length ? Math.round(Math.min(1, (need.filter((t) => cvTokens.has(t)).length / need.length) * 1.8) * 100) : 40;
  const relevance = targets.length ? Math.round(35 + titleProximity(title, targets) * 60) : Math.min(95, fit + 15);
  const missing = need.filter((t) => !cvTokens.has(t)).slice(0, 3);
  return { relevance, fit, strategic: /\bstrat[ée]gique\b/i.test(offer), summary: `Simulation : intitulé « ${title} », recouvrement du vocabulaire ${fit} %.`, strengths: need.filter((t) => cvTokens.has(t)).slice(0, 3), gaps: missing, blockers: [] };
});
