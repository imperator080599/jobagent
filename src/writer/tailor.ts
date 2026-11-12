// Agent de personnalisation du CV. Le CV master est la seule source de vérité :
// l'agent ne rédige pas un nouveau CV, il propose des modifications ciblées,
// élément par élément (identifiants du master). Chaque proposition est ensuite
// contrôlée par du code — chiffres, noms propres, sigles, mots-clés — puis par un
// second modèle chargé uniquement de traquer tout fait ajouté. Une proposition
// douteuse est refusée et le texte d'origine est conservé.
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { UserContext } from '../core/context.js';
import { logActivity } from '../core/activity.js';
import { normalize } from '../core/text.js';
import { newId } from '../db/ids.js';
import { cvVersions } from '../db/schema.js';
import { renderCvVersion, type RenderOutcome } from '../docs/generate.js';
import { getLlm, UNTRUSTED_RULE } from '../llm/index.js';
import { registerMock } from '../llm/mock.js';
import type { AtsParsed } from '../pipeline/ats.js';
import { applicationNotes, candidateBrief, clarificationsText, type CandidateBrief } from '../pipeline/brief.js';
import { jobBlock } from '../pipeline/qualify.js';
import type { CvVersion } from '../profile/cv.js';
import { type Bullet, type CvData, stripMarkup } from '../shared/cv.js';
import type { Job } from '../tracker/stage.js';

// ── Proposition du modèle ──

export const TailorOut = z.object({
  summary: z.string().describe("Accroche adaptée à l'offre, sans fait nouveau. Chaîne vide pour conserver l'accroche du master (ou s'il n'y en a pas)."),
  rewrites: z
    .array(z.object({ id: z.string().describe("Identifiant de l'élément du master (ex. exp_1.b3)."), text: z.string().describe('Nouvelle rédaction, pas plus longue que l\'originale.'), why: z.string().describe("Ce que la reformulation apporte pour cette offre, en quelques mots.") }))
    .describe('Éléments reformulés. Ne cite que ceux qui changent réellement.'),
  orders: z.array(z.object({ parentId: z.string().describe('Identifiant de l\'expérience ou de la rubrique (ex. exp_1).'), ids: z.array(z.string()).describe('Tous les éléments de ce parent, dans le nouvel ordre.') })).describe('Nouvel ordre des puces, uniquement pour les parents dont l\'ordre change.'),
  skills: z.array(z.object({ id: z.string(), items: z.array(z.string()) })).describe('Groupes de compétences réordonnés ou complétés d\'une compétence confirmée par le candidat.'),
  keywordsIntegrated: z.array(z.string()).describe("Mots-clés de l'offre désormais présents dans le CV."),
  keywordsSkipped: z.array(z.object({ keyword: z.string(), reason: z.string() })).describe("Mots-clés de l'offre NON intégrés, faute d'expérience réelle qui les justifie."),
  notes: z.string().describe('Remarques utiles au candidat (limites, arbitrages), deux phrases au plus.'),
});
export type TailorOut = z.infer<typeof TailorOut>;

const SYSTEM = `Tu adaptes le CV d'un candidat à une offre d'emploi précise. Tu ne rédiges pas un nouveau CV : tu proposes des modifications ciblées de son CV master, élément par élément, en citant leurs identifiants.

RÈGLE ABSOLUE — le CV master est la seule source de vérité. Il est strictement interdit :
- d'inventer une expérience, une responsabilité, un résultat chiffré ou une compétence ;
- de transformer une connaissance théorique en expérience professionnelle ;
- d'exagérer un niveau de maîtrise ou l'ampleur d'une mission ;
- de modifier une date, un intitulé de poste, un nom d'entreprise, un diplôme ;
- d'ajouter une certification non obtenue.
Chaque reformulation doit pouvoir être justifiée par l'élément d'origine (même identifiant) ou par une « précision validée » du candidat. Un mot-clé de l'offre n'est intégré que si l'expérience réellement décrite le justifie ; sinon, range-le dans keywordsSkipped avec la raison.

Ce que tu peux faire :
- reformuler une puce pour employer le vocabulaire de l'offre lorsque l'activité décrite est bien la même ;
- réordonner les puces d'une expérience pour faire remonter les plus utiles à cette offre ;
- réordonner les éléments d'une ligne de compétences, ou y ajouter une compétence que le candidat a confirmée ;
- adapter l'accroche, si le CV en a une, sans y introduire de fait nouveau.

Contraintes de forme :
- même langue que le CV master ;
- les chiffres sont repris tels quels ;
- la mise en valeur est conservée (**gras** en tête de puce lorsque l'original en porte un) ;
- une puce reformulée n'est pas plus longue que l'originale : le CV doit tenir sur le même nombre de pages ;
- ne supprime aucun élément ; ne touche qu'à ce qui sert cette candidature. Laisser un élément inchangé est souvent le bon choix.
${UNTRUSTED_RULE}`;

type ElementRef = { id: string; text: string; parentId: string; set: (text: string) => void };

/** Index des éléments rédigés du CV (puces, détails, lignes de rubriques) par identifiant. */
function indexElements(cv: CvData): Map<string, ElementRef> {
  const out = new Map<string, ElementRef>();
  const add = (list: Bullet[], parentId: string) => list.forEach((b) => out.set(b.id, { id: b.id, text: b.text, parentId, set: (t) => (b.text = t) }));
  cv.experiences.forEach((e) => add(e.bullets, e.id));
  cv.education.forEach((e) => add(e.details, e.id));
  cv.extras.forEach((x) => add(x.items, x.id));
  return out;
}

/** CV avec identifiants, tel qu'il est présenté au modèle. */
export function cvWithIds(cv: CvData): string {
  const L: string[] = [];
  if (cv.summary) L.push(`[summary] ${cv.summary}`);
  for (const e of cv.experiences) {
    L.push('', `[${e.id}] ${e.title} — ${e.company}${e.location ? ` (${e.location})` : ''}${e.dates ? ` | ${e.dates}` : ''}`);
    if (e.summary) L.push(`  ${e.summary}`);
    for (const b of e.bullets) L.push(`  [${b.id}] ${b.text}`);
  }
  for (const e of cv.education) {
    L.push('', `[${e.id}] ${[e.degree, e.field].filter(Boolean).join(', ')} — ${e.school}${e.dates ? ` | ${e.dates}` : ''}`);
    for (const b of e.details) L.push(`  [${b.id}] ${b.text}`);
  }
  for (const g of cv.skills) L.push('', `[${g.id}] ${g.label ? `${g.label} : ` : ''}${g.items.join(', ')}`);
  for (const l of cv.languages) L.push(`[${l.id}] ${l.language}${l.level ? ` : ${l.level}` : ''}`);
  for (const c of cv.certifications) L.push(`[${c.id}] ${c.name}${c.issuer ? ` — ${c.issuer}` : ''}`);
  for (const x of cv.extras) {
    L.push('', `[${x.id}] ${x.title}`);
    for (const b of x.items) L.push(`  [${b.id}] ${b.text}`);
  }
  return L.join('\n').trim();
}

// ── Garde-fous déterministes ──

const numbers = (s: string): string[] => (stripMarkup(s).match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(',', '.').replace(/\.0+$/, ''));

/** Sigles, noms propres et noms d'outils : tout mot portant une majuscule hors début de phrase, un chiffre ou un signe technique. */
function namedTerms(s: string): string[] {
  const out: string[] = [];
  const words = stripMarkup(s).split(/[\s,;:()/]+/).filter(Boolean);
  words.forEach((raw, i) => {
    const w = raw.replace(/^[^\p{L}\p{N}+#]+|[^\p{L}\p{N}+#]+$/gu, '');
    if (w.length < 2) return;
    const startsSentence = i === 0 || /[.!?]$/.test(words[i - 1] ?? '');
    const acronym = /^[\p{Lu}\d&+#.-]{2,}$/u.test(w) && /\p{Lu}/u.test(w);
    const technical = /[\d+#]/.test(w) && /\p{L}/u.test(w);
    const proper = /^\p{Lu}\p{Ll}/u.test(w) && !startsSentence;
    if (acronym || technical || proper) out.push(w);
  });
  return out;
}

export interface TailorGuard {
  /** Texte intégral du master, normalisé. */
  masterText: string;
  /** Texte intégral du master, tel quel (pour la comparaison des chiffres). */
  masterRaw: string;
  /** Précisions validées (compétences confirmées, corrections) : seules sources admises en plus du master. */
  allowedText: string;
  /** Mots-clés signalés absents par l'analyse ATS : leur ajout exige une justification explicite. */
  missingKeywords: { norm: string; label: string }[];
  /** Compétences que le candidat a déclaré ne pas maîtriser. */
  denied: string[];
}

export function buildGuard(master: CvData, brief: Pick<CandidateBrief, 'confirmedSkills' | 'deniedSkills' | 'corrections'>, notes: string[], missingKeywords: string[]): TailorGuard {
  const masterRaw = stripMarkup(cvWithIds(master)).replace(/\[[a-z]+_\d+(?:\.[a-z]\d+)?\]/g, ' ');
  const masterText = normalize(masterRaw);
  const allowed = [...brief.confirmedSkills.map((s) => `${s.name} ${s.context ?? ''}`), ...brief.corrections, ...notes].join(' \n ');
  return { masterText, masterRaw, allowedText: normalize(allowed), missingKeywords: missingKeywords.map((k) => ({ norm: normalize(k), label: k.trim() })).filter((k) => k.norm.length > 1), denied: brief.deniedSkills.map((s) => normalize(s.name)).filter(Boolean) };
}

const has = (hay: string, needle: string) => new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(hay);

/** Contrôle une reformulation. Renvoie la raison du refus, ou null si elle est acceptable. */
export function checkRewrite(original: string, proposed: string, guard: TailorGuard, opts: { wholeCv?: boolean } = {}): string | null {
  const text = proposed.trim();
  if (!text) return 'texte vide';
  if (/[[\]{}]|\b(TODO|XXX|lorem)\b/i.test(stripMarkup(text))) return 'zone à compléter laissée dans le texte';
  const source = normalize(stripMarkup(original));
  const next = normalize(stripMarkup(text));
  // 1. Aucun chiffre nouveau : tout nombre doit figurer dans l'élément d'origine.
  const allowedNumbers = new Set(numbers(opts.wholeCv ? guard.masterRaw : original));
  const newNumber = numbers(text).find((n) => !allowedNumbers.has(n));
  if (newNumber) return `chiffre « ${newNumber} » absent de l'élément d'origine`;
  // 2. Aucune compétence que le candidat a déclaré ne pas maîtriser.
  const denied = guard.denied.find((d) => has(next, d) && !has(source, d));
  if (denied) return `« ${denied} » : compétence que vous avez déclaré ne pas maîtriser`;
  // 3. Sigles, noms propres, outils : présents dans le master ou dans une précision validée.
  for (const term of namedTerms(text)) {
    const t = normalize(term);
    if (!t || has(source, t)) continue;
    if (has(guard.masterText, t) || has(guard.allowedText, t)) continue;
    return `« ${term} » ne figure ni dans le CV master ni dans vos précisions`;
  }
  // 4. Mots-clés manquants selon l'analyse ATS : pas d'ajout sans justification.
  for (const k of guard.missingKeywords) {
    if (has(next, k.norm) && !has(source, k.norm) && !has(guard.masterText, k.norm) && !has(guard.allowedText, k.norm)) return `mot-clé « ${k.label} » ajouté sans expérience qui le justifie`;
  }
  return null;
}

export interface TailorChange {
  id: string;
  kind: 'rewrite' | 'order' | 'skills' | 'summary';
  before: string;
  after: string;
  why?: string;
}
export interface TailorRejection {
  id: string;
  proposed: string;
  reason: string;
}

export interface TailorResult {
  cv: CvData;
  changes: TailorChange[];
  rejected: TailorRejection[];
}

/** Applique la proposition du modèle au master, en refusant tout ce qui ne passe pas les contrôles. */
export function applyTailoring(master: CvData, out: TailorOut, guard: TailorGuard): TailorResult {
  const cv: CvData = structuredClone(master);
  const elements = indexElements(cv);
  const changes: TailorChange[] = [];
  const rejected: TailorRejection[] = [];

  for (const r of out.rewrites) {
    const el = elements.get(r.id);
    if (!el) {
      rejected.push({ id: r.id, proposed: r.text, reason: 'identifiant inconnu du CV master' });
      continue;
    }
    if (normalize(stripMarkup(r.text)) === normalize(stripMarkup(el.text))) continue;
    const reason = checkRewrite(el.text, r.text, guard);
    if (reason) rejected.push({ id: r.id, proposed: r.text, reason });
    else {
      changes.push({ id: r.id, kind: 'rewrite', before: el.text, after: r.text.trim(), why: r.why });
      el.set(r.text.trim());
    }
  }

  if (out.summary.trim() && master.summary && normalize(out.summary) !== normalize(master.summary)) {
    const reason = checkRewrite(master.summary, out.summary, guard, { wholeCv: true });
    if (reason) rejected.push({ id: 'summary', proposed: out.summary, reason });
    else {
      changes.push({ id: 'summary', kind: 'summary', before: master.summary, after: out.summary.trim() });
      cv.summary = out.summary.trim();
    }
  }

  // Ordre des puces : permutation stricte des éléments existants (rien ne disparaît, rien n'apparaît).
  const parents = new Map<string, Bullet[]>();
  cv.experiences.forEach((e) => parents.set(e.id, e.bullets));
  cv.education.forEach((e) => parents.set(e.id, e.details));
  cv.extras.forEach((x) => parents.set(x.id, x.items));
  for (const o of out.orders) {
    const list = parents.get(o.parentId);
    if (!list || list.length < 2) continue;
    const byId = new Map(list.map((b) => [b.id, b]));
    const next: Bullet[] = [];
    for (const id of o.ids) {
      const b = byId.get(id);
      if (b && !next.includes(b)) next.push(b);
    }
    for (const b of list) if (!next.includes(b)) next.push(b);
    const before = list.map((b) => b.id).join(', ');
    const after = next.map((b) => b.id).join(', ');
    if (before !== after) {
      list.splice(0, list.length, ...next);
      changes.push({ id: o.parentId, kind: 'order', before, after });
    }
  }

  // Compétences : chaque élément doit exister dans le master ou avoir été confirmé ; aucun élément d'origine n'est perdu.
  for (const s of out.skills) {
    const group = cv.skills.find((g) => g.id === s.id);
    if (!group) continue;
    const original = [...group.items];
    const kept: string[] = [];
    for (const item of s.items.map((i) => i.trim()).filter(Boolean)) {
      const n = normalize(item);
      if (kept.some((k) => normalize(k) === n)) continue;
      const fromMaster = original.find((o) => normalize(o) === n);
      if (fromMaster) kept.push(fromMaster);
      else if (guard.denied.some((d) => has(n, d))) rejected.push({ id: s.id, proposed: item, reason: 'compétence que vous avez déclaré ne pas maîtriser' });
      else if (has(guard.masterText, n) || has(guard.allowedText, n)) kept.push(item);
      else rejected.push({ id: s.id, proposed: item, reason: 'compétence absente du CV master et non confirmée' });
    }
    for (const o of original) if (!kept.some((k) => normalize(k) === normalize(o))) kept.push(o);
    if (kept.join('|') !== original.join('|')) {
      changes.push({ id: s.id, kind: 'skills', before: original.join(', '), after: kept.join(', ') });
      group.items = kept;
    }
  }
  return { cv, changes, rejected };
}

/** Annule une modification (retour au texte du master pour cet élément). */
function revert(cv: CvData, master: CvData, change: TailorChange) {
  if (change.kind === 'summary') cv.summary = master.summary;
  else if (change.kind === 'rewrite') indexElements(cv).get(change.id)?.set(change.before);
  else if (change.kind === 'skills') {
    const g = cv.skills.find((x) => x.id === change.id);
    const m = master.skills.find((x) => x.id === change.id);
    if (g && m) g.items = [...m.items];
  }
}

// ── Vérification par un second modèle ──

const VerifyOut = z.object({ verdicts: z.array(z.object({ id: z.string(), ok: z.boolean(), issue: z.string() })) });

const VERIFY_SYSTEM = `Tu contrôles des reformulations de CV. Pour chaque paire, compare la version proposée à l'original et réponds ok=false si la version proposée affirme quoi que ce soit que l'original ne contient pas : responsabilité, outil, méthode, périmètre, résultat, chiffre, niveau de maîtrise, ancienneté, secteur, nom propre. Un simple changement de vocabulaire ou d'ordre, à sens égal, est ok=true. Dans le doute, réponds ok=false. « issue » décrit l'ajout en une courte phrase (chaîne vide si ok).
Les « précisions validées » du candidat, lorsqu'elles sont fournies, sont des faits admis.`;

async function verifyWithModel(ctx: UserContext, changes: TailorChange[], clarifications: string, jobId: string): Promise<Map<string, string>> {
  const pairs = changes.filter((c) => c.kind === 'rewrite' || c.kind === 'summary');
  const issues = new Map<string, string>();
  if (!pairs.length) return issues;
  const llm = await getLlm(ctx);
  const res = await llm.json({
    purpose: 'cv.verify',
    tier: 'bulk',
    system: VERIFY_SYSTEM,
    prompt: `${clarifications ? `<precisions_validees>\n${clarifications}\n</precisions_validees>\n\n` : ''}${pairs.map((p) => `<paire id="${p.id}">\n<original>${stripMarkup(p.before)}</original>\n<propose>${stripMarkup(p.after)}</propose>\n</paire>`).join('\n')}`,
    schema: VerifyOut,
    maxTokens: 2500,
    effort: 'low',
    jobId,
  });
  for (const v of res.data.verdicts) if (!v.ok) issues.set(v.id, v.issue || 'ajout non justifié par le texte d\'origine');
  // Une paire sans verdict n'est pas considérée comme validée.
  for (const p of pairs) if (!res.data.verdicts.some((v) => v.id === p.id)) issues.set(p.id, 'non vérifiée par le contrôle de véracité');
  return issues;
}

// ── Exécution ──

export interface TailorRun {
  cv: CvVersion;
  changes: TailorChange[];
  rejected: TailorRejection[];
  render: RenderOutcome;
  keywordsIntegrated: string[];
  keywordsSkipped: { keyword: string; reason: string }[];
  notes: string;
  /** Modifications annulées pour que le document tienne sur la pagination du template. */
  revertedForLayout: string[];
}

async function nextApplicationVersion(ctx: UserContext, jobId: string): Promise<number> {
  const [row] = await ctx.db
    .select({ v: sql<number>`coalesce(max(${cvVersions.version}), 0)::int` })
    .from(cvVersions)
    .where(and(eq(cvVersions.userId, ctx.userId), eq(cvVersions.jobId, jobId), eq(cvVersions.kind, 'application')));
  return (row?.v ?? 0) + 1;
}

const overflowed = (r: RenderOutcome) => r.checks.some((c) => c.id === 'pages' && !c.ok);

export async function tailorCv(ctx: UserContext, job: Job, opts: { master: CvVersion; analysis: AtsParsed | null; instructions?: string }): Promise<TailorRun> {
  const master = opts.master;
  const brief = await candidateBrief(ctx, { master });
  const notes = await applicationNotes(ctx, job.id);
  if (opts.instructions?.trim()) notes.push(opts.instructions.trim());
  const clarifications = clarificationsText(brief, notes);
  const missing = opts.analysis?.missingKeywords ?? [];
  const guard = buildGuard(master.data, brief, notes, missing);
  const llm = await getLlm(ctx);
  const improvements = (opts.analysis?.items ?? []).filter((i) => i.improvement.trim()).map((i) => `- ${i.label}${i.score5 != null ? ` (${i.score5}/5)` : ''} : ${i.improvement}`);
  const res = await llm.json({
    purpose: 'cv.tailor',
    tier: 'main',
    system: SYSTEM,
    prefix: `<cv_master langue="${master.language}">\n${cvWithIds(master.data)}\n</cv_master>${clarifications ? `\n\n<precisions_validees>\n${clarifications}\n</precisions_validees>` : ''}${brief.styleRules.length ? `\n\n<regles_de_redaction>\n${brief.styleRules.map((r) => `- ${r}`).join('\n')}\n</regles_de_redaction>` : ''}`,
    prompt: `Offre visée :\n\n${jobBlock(job)}\n\n${improvements.length ? `Points d'amélioration relevés par l'analyse ATS du candidat :\n${improvements.join('\n')}\n\n` : ''}${missing.length ? `Mots-clés signalés absents du CV : ${missing.join(', ')}\n\n` : ''}Propose les modifications du CV master pour cette offre.`,
    schema: TailorOut,
    maxTokens: 6000,
    effort: 'high',
    jobId: job.id,
  });
  const applied = applyTailoring(master.data, res.data, guard);
  // Second contrôle, par un modèle distinct chargé uniquement de repérer les ajouts.
  const issues = await verifyWithModel(ctx, applied.changes, clarifications, job.id);
  for (const [id, issue] of issues) {
    const change = applied.changes.find((c) => c.id === id && (c.kind === 'rewrite' || c.kind === 'summary'));
    if (!change) continue;
    revert(applied.cv, master.data, change);
    applied.rejected.push({ id, proposed: change.after, reason: issue });
    applied.changes.splice(applied.changes.indexOf(change), 1);
  }

  const summaryOf = (changes: TailorChange[]) => {
    const n = (k: TailorChange['kind']) => changes.filter((c) => c.kind === k).length;
    const parts = [n('rewrite') ? `${n('rewrite')} reformulation(s)` : '', n('order') ? `${n('order')} réorganisation(s)` : '', n('skills') ? 'compétences réordonnées' : '', n('summary') ? 'accroche adaptée' : ''].filter(Boolean);
    return parts.length ? parts.join(', ') : 'aucune modification utile : le CV master est repris tel quel';
  };
  const [row] = await ctx.db
    .insert(cvVersions)
    .values({
      id: newId('cv'),
      userId: ctx.userId,
      kind: 'application',
      label: `${job.companyName} — ${job.title}`.slice(0, 160),
      language: master.language,
      version: await nextApplicationVersion(ctx, job.id),
      data: applied.cv,
      source: 'tailor',
      parentId: master.id,
      jobId: job.id,
      status: 'draft',
      changeSummary: summaryOf(applied.changes),
      provenance: { masterId: master.id, masterVersion: master.version, changes: applied.changes, rejected: applied.rejected } as unknown as Record<string, unknown>,
      sourceFileId: null,
      createdBy: 'agent:cv',
    })
    .returning();
  const cv = row!;
  const label = `${job.companyName} ${job.title}`;
  let render = await renderCvVersion(ctx, cv.id, { label });
  const revertedForLayout: string[] = [];
  // Le document dépasse la pagination du template : on revient au texte d'origine pour les éléments allongés,
  // puis, si nécessaire, pour toutes les reformulations. Aucune information n'est supprimée pour gagner de la place.
  for (const pass of ['longer', 'all'] as const) {
    if (render.ok === null || !overflowed(render)) break;
    const candidates = applied.changes.filter((c) => (c.kind === 'rewrite' || c.kind === 'summary' || c.kind === 'skills') && (pass === 'all' || stripMarkup(c.after).length > stripMarkup(c.before).length));
    if (!candidates.length) continue;
    for (const c of candidates) {
      revert(applied.cv, master.data, c);
      revertedForLayout.push(c.id);
      applied.changes.splice(applied.changes.indexOf(c), 1);
    }
    await ctx.db
      .update(cvVersions)
      .set({ data: applied.cv, changeSummary: summaryOf(applied.changes), provenance: { masterId: master.id, masterVersion: master.version, changes: applied.changes, rejected: applied.rejected, revertedForLayout } as unknown as Record<string, unknown> })
      .where(eq(cvVersions.id, cv.id));
    render = await renderCvVersion(ctx, cv.id, { label });
  }
  await logActivity(ctx.db, { userId: ctx.userId, actor: 'agent:cv', action: 'cv.tailored', summary: `${job.companyName} — ${job.title} : ${summaryOf(applied.changes)}${applied.rejected.length ? ` ; ${applied.rejected.length} proposition(s) refusée(s) par le contrôle de véracité` : ''}`, entityType: 'cv', entityId: cv.id, data: { jobId: job.id, changes: applied.changes.length, rejected: applied.rejected.length, renderOk: render.ok } });
  const [fresh] = await ctx.db.select().from(cvVersions).where(eq(cvVersions.id, cv.id));
  return { cv: fresh ?? cv, changes: applied.changes, rejected: applied.rejected, render, keywordsIntegrated: res.data.keywordsIntegrated, keywordsSkipped: res.data.keywordsSkipped, notes: res.data.notes, revertedForLayout };
}

// ── Simulations (tests, démonstration) ──

registerMock('cv.tailor', (req) => {
  // Fait remonter, dans la première expérience, la puce qui partage le plus de vocabulaire avec l'offre.
  const cv = /<cv_master[^>]*>\n([\s\S]*?)\n<\/cv_master>/.exec(req.prefix ?? '')?.[1] ?? '';
  const offer = normalize(/<donnees_non_fiables[^>]*>\n([\s\S]*)\n<\/donnees_non_fiables>/.exec(req.prompt)?.[1] ?? '');
  const bullets = [...cv.matchAll(/^\s+\[(exp_\d+)\.(b\d+)\] (.*)$/gm)].map((m) => ({ parent: m[1]!, id: `${m[1]}.${m[2]}`, text: m[3]! }));
  const first = bullets.filter((b) => b.parent === bullets[0]?.parent);
  const score = (t: string) => normalize(stripMarkup(t)).split(' ').filter((w) => w.length > 4 && offer.includes(w)).length;
  const ordered = [...first].sort((a, b) => score(b.text) - score(a.text));
  return { summary: '', rewrites: [], orders: first.length > 1 ? [{ parentId: first[0]!.parent, ids: ordered.map((b) => b.id) }] : [], skills: [], keywordsIntegrated: [], keywordsSkipped: [], notes: 'Simulation : seules les puces ont été réordonnées.' };
});

registerMock('cv.verify', (req) => ({ verdicts: [...req.prompt.matchAll(/<paire id="([^"]+)">/g)].map((m) => ({ id: m[1]!, ok: true, issue: '' })) }));
