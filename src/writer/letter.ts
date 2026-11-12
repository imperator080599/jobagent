// Agent de lettre de motivation. La structure vient du modèle de lettre de
// l'utilisateur (une rubrique par zone du template, avec la consigne qui y figure) ;
// l'en-tête, la date, la formule d'appel et la formule de politesse sont posés par
// du code, selon la langue et le pays. Le modèle ne rédige que le corps, à partir
// du CV master et des informations validées, puis un contrôle de véracité relit le tout.
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { UserContext } from '../core/context.js';
import { logActivity } from '../core/activity.js';
import { ConfigError } from '../core/errors.js';
import { newId } from '../db/ids.js';
import { letters } from '../db/schema.js';
import { renderLetterDocument, type RenderOutcome } from '../docs/generate.js';
import { closing, formatLetterDate, letterLanguage, salutation, type LetterLanguage } from '../docs/letter-conventions.js';
import type { LetterContent, LetterTemplateProfile } from '../docs/letter-template.js';
import { getActiveTemplate } from '../docs/templates.js';
import { getLlm, UNTRUSTED_RULE } from '../llm/index.js';
import { registerMock } from '../llm/mock.js';
import { applicationNotes, candidateBrief, clarificationsText, profileBlock } from '../pipeline/brief.js';
import { jobBlock } from '../pipeline/qualify.js';
import type { CvVersion } from '../profile/cv.js';
import { factsMap } from '../profile/facts.js';
import { cvToText } from '../shared/cv.js';
import type { Job } from '../tracker/stage.js';

export type Letter = typeof letters.$inferSelect;

const LetterOut = z.object({
  sections: z.array(z.object({ key: z.string().describe('Clé de la rubrique du modèle.'), paragraphs: z.array(z.string()).min(1).max(3).describe('Un à trois paragraphes rédigés.') })),
  subject: z.string().describe("Objet de la lettre (ex. « Candidature au poste de … »), dans la langue de la lettre."),
  recipientName: z.string().describe("Nom du destinataire s'il est cité explicitement dans l'annonce, sinon chaîne vide. Ne jamais le deviner."),
  notes: z.string().describe('Informations qui manquaient pour personnaliser la lettre, à signaler au candidat. Chaîne vide si rien.'),
});
type LetterOut = z.infer<typeof LetterOut>;

const LANG_NAMES: Record<LetterLanguage, string> = { fr: 'français', en: 'anglais', es: 'espagnol', de: 'allemand' };

function system(lang: LetterLanguage, maxWords: number, styleRules: string[]): string {
  return `Tu rédiges le corps de la lettre de motivation d'un candidat pour une offre précise, en suivant la structure de SON modèle de lettre : une rubrique par zone du modèle, dans l'ordre, en respectant la consigne propre à chaque rubrique.

Véracité — règle absolue : tout fait (expérience, mission, résultat, chiffre, compétence, diplôme, langue, date) doit figurer dans le CV master ou dans les informations validées par le candidat. N'invente ni anecdote, ni motivation personnelle, ni réalisation. Sur l'entreprise, n'utilise que ce que dit l'annonce : aucune affirmation tirée de ta mémoire (classements, actualité, chiffres, valeurs supposées). Si une rubrique appelle une information absente du dossier, rédige-la sobrement avec ce qui est disponible et signale le manque dans « notes ».

Rédaction : en ${LANG_NAMES[lang]} ; ton professionnel, direct et concret ; pas de superlatifs, pas de formules toutes faites, pas de flatterie ; phrases courtes ; aucun titre, aucune liste à puces, aucun gras ; ne recopie pas le CV ligne à ligne : relie deux ou trois expériences réelles aux besoins exprimés par l'annonce.${styleRules.length ? `\nRègles de rédaction du candidat, à respecter : ${styleRules.join(' ; ')}.` : ''}

Longueur : la lettre doit tenir sur UNE page de son modèle — ${maxWords} mots au total pour l'ensemble des rubriques, pas davantage.
Ne rédige ni l'en-tête, ni la date, ni la formule d'appel, ni la formule de politesse, ni la signature : ils sont ajoutés automatiquement.
${UNTRUSTED_RULE}`;
}

const numbersOf = (s: string) => (s.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(',', '.'));

/** Contrôle déterministe : aucun chiffre qui ne vienne du CV, des précisions ou de l'annonce ; aucune zone laissée à remplir. */
export function checkLetterBody(paragraphs: string[], sources: string): string[] {
  const issues: string[] = [];
  const allowed = new Set(numbersOf(sources));
  for (const p of paragraphs) {
    for (const n of numbersOf(p)) if (!allowed.has(n)) issues.push(`Le chiffre « ${n} » ne figure ni dans votre CV ni dans l'annonce.`);
    const hole = /\[[^\]]{1,60}\]|\{\{[^}]+\}\}|\bXX+\b|\bTBD\b|\bTODO\b/.exec(p);
    if (hole) issues.push(`Zone à compléter laissée dans le texte : « ${hole[0]} ».`);
    if (/^\s*[-•*]\s/m.test(p)) issues.push('La lettre contient une liste à puces.');
  }
  return [...new Set(issues)];
}

const VerifyOut = z.object({ issues: z.array(z.object({ excerpt: z.string(), problem: z.string() })).max(10) });
const VERIFY_SYSTEM = `Tu contrôles la véracité d'une lettre de motivation. Relève chaque affirmation factuelle concernant le candidat (expérience, mission, résultat, chiffre, compétence, diplôme, langue, durée) qui ne figure pas dans son dossier, et chaque affirmation sur l'entreprise qui ne figure pas dans l'annonce. Les intentions et motivations exprimées sobrement ne sont pas des faits à vérifier, sauf si elles contredisent le dossier. « excerpt » cite le passage concerné, « problem » dit ce qui n'est pas étayé. Rends une liste vide si tout est étayé.`;

export interface LetterRun {
  letter: Letter;
  render: RenderOutcome;
  issues: string[];
  notes: string;
  words: number;
}

function wordsOf(sections: LetterOut['sections']): number {
  return sections.flatMap((s) => s.paragraphs).join(' ').split(/\s+/).filter(Boolean).length;
}

export async function writeLetter(ctx: UserContext, job: Job, opts: { master: CvVersion; cvVersionId?: string | null; instructions?: string }): Promise<LetterRun> {
  const lang = letterLanguage(job.language || opts.master.language);
  const template = await getActiveTemplate(ctx.db, ctx.userId, 'letter', lang);
  if (!template) throw new ConfigError("Aucun modèle de lettre n'est importé (Profil → Mes documents).", 'letter_template_missing');
  const profile = template.profile as unknown as LetterTemplateProfile;
  const brief = await candidateBrief(ctx, { master: opts.master });
  const notes = await applicationNotes(ctx, job.id);
  if (opts.instructions?.trim()) notes.push(opts.instructions.trim());
  const facts = await factsMap(ctx.db, ctx.userId);
  const fact = (key: string) => {
    const v = facts.get(key)?.value;
    return typeof v === 'string' ? v.trim() : '';
  };
  const id = opts.master.data.identity;
  const sender = { name: id.fullName, phone: fact('contact.phone') || id.phone, email: fact('contact.email') || id.email, linkedin: fact('contact.linkedin_url') || id.linkedin, address: [fact('contact.address'), [fact('contact.postal_code'), fact('contact.city')].filter(Boolean).join(' ')].filter(Boolean).join(', ') || undefined };
  const llm = await getLlm(ctx);
  const sources = `${cvToText(opts.master.data)}\n${clarificationsText(brief, notes)}\n${brief.facts.map((f) => f.value).join('\n')}\n${job.title}\n${job.descriptionText}`;
  const structure = profile.sections.map((s, i) => `${i + 1}. clé « ${s.key} » — ${s.label}${s.brief ? ` : ${s.brief}` : ''}`).join('\n');
  const prefix = `Dossier du candidat :\n\n${profileBlock(brief)}`;

  let budget = 300;
  let out: LetterOut | null = null;
  let issues: string[] = [];
  let render: RenderOutcome | null = null;
  let letterId = '';
  let content: LetterContent | null = null;
  let feedbackForRetry = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await llm.json({
      purpose: 'letter.write',
      tier: 'main',
      system: system(lang, budget, brief.styleRules),
      prefix,
      prompt: `Structure du modèle de lettre du candidat (rubriques à rédiger, dans cet ordre) :\n${structure}\n\n${notes.length ? `Consignes du candidat pour cette candidature :\n${notes.map((n) => `- ${n}`).join('\n')}\n\n` : ''}Offre visée :\n\n${jobBlock(job)}${feedbackForRetry ? `\n\nTa version précédente posait les problèmes suivants ; corrige-les :\n${feedbackForRetry}` : ''}`,
      schema: LetterOut,
      maxTokens: 3000,
      effort: 'high',
      jobId: job.id,
    });
    out = res.data;
    // Rubriques : exactement celles du modèle, dans son ordre.
    const byKey = new Map(out.sections.map((s) => [s.key, s.paragraphs.map((p) => p.replace(/\*\*/g, '').trim()).filter(Boolean)]));
    const sections: Record<string, string[]> = {};
    const missingSections: string[] = [];
    for (const s of profile.sections) {
      const p = byKey.get(s.key);
      if (p?.length) sections[s.key] = p;
      else missingSections.push(s.label);
    }
    const body = Object.values(sections).flat();
    issues = checkLetterBody(body, sources);
    if (missingSections.length) issues.push(`Rubrique(s) du modèle non rédigée(s) : ${missingSections.join(', ')}.`);
    if (!issues.length && body.length) {
      try {
        const v = await llm.json({ purpose: 'letter.verify', tier: 'bulk', system: VERIFY_SYSTEM, prefix, prompt: `Annonce :\n\n${jobBlock(job, 8000)}\n\n<lettre>\n${body.join('\n\n')}\n</lettre>`, schema: VerifyOut, maxTokens: 1500, effort: 'low', jobId: job.id });
        issues = v.data.issues.map((i) => `« ${i.excerpt.slice(0, 120)} » — ${i.problem}`);
      } catch (err) {
        ctx.log.warn('letter_verify_failed', { error: String(err) });
        issues = ['Le contrôle de véracité automatique n\'a pas pu être exécuté : relisez attentivement cette lettre.'];
      }
    }
    const recipientName = out.recipientName.trim() && new RegExp(out.recipientName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(job.descriptionText) ? out.recipientName.trim() : '';
    content = {
      sender,
      recipient: { name: recipientName || undefined, company: job.companyName },
      date: formatLetterDate(ctx.now(), lang, job.country, fact('contact.city')),
      subject: out.subject.trim() || undefined,
      salutation: salutation(lang, { name: recipientName || undefined }),
      sections,
      closing: closing(lang, job.country, Boolean(recipientName)),
      signature: fact('writing.signature') || id.fullName,
    };
    if (issues.length && attempt < 2) {
      feedbackForRetry = issues.map((i) => `- ${i}`).join('\n');
      continue;
    }
    if (!letterId) {
      letterId = newId('let');
      await ctx.db.insert(letters).values({ id: letterId, userId: ctx.userId, kind: 'application', jobId: job.id, cvVersionId: opts.cvVersionId ?? null, language: lang, content: content as unknown as Record<string, unknown>, text: '', status: 'draft', createdBy: 'agent:letter' });
    }
    render = await renderLetterDocument(ctx, letterId, content, { label: `${job.companyName} ${job.title}`, language: lang });
    const tooLong = render.checks.some((c) => c.id === 'pages' && !c.ok);
    if (tooLong && attempt < 2) {
      // La lettre déborde de la page du modèle : nouvelle rédaction plus courte (rien n'est tronqué mécaniquement).
      budget = Math.round(Math.min(budget, wordsOf(out.sections)) * 0.8);
      feedbackForRetry = `- La lettre dépasse une page dans le modèle : réduis à ${budget} mots au total.`;
      continue;
    }
    break;
  }
  if (!out || !content || !render || !letterId) throw new Error("La lettre n'a pas pu être rédigée.");
  const text = [content.salutation, ...Object.values(content.sections).flat(), content.closing, content.signature].join('\n\n');
  const [prev] = await ctx.db.select({ checks: letters.checks }).from(letters).where(eq(letters.id, letterId));
  const [row] = await ctx.db
    .update(letters)
    .set({ content: content as unknown as Record<string, unknown>, text, checks: { ...(prev?.checks ?? {}), truthfulness: { ok: issues.length === 0, issues }, notes: out.notes, words: wordsOf(out.sections) } })
    .where(and(eq(letters.id, letterId), eq(letters.userId, ctx.userId)))
    .returning();
  await logActivity(ctx.db, { userId: ctx.userId, actor: 'agent:letter', action: 'letter.written', summary: `${job.companyName} — ${job.title} : lettre rédigée (${wordsOf(out.sections)} mots)${issues.length ? `, ${issues.length} point(s) à vérifier` : ''}`, entityType: 'letter', entityId: letterId, data: { jobId: job.id, renderOk: render.ok, issues: issues.length } });
  return { letter: row!, render, issues, notes: out.notes, words: wordsOf(out.sections) };
}

// ── Simulations (tests, démonstration) ──

registerMock('letter.write', (req) => {
  const keys = [...req.prompt.matchAll(/clé « ([^»]+) »/g)].map((m) => m[1]!.trim());
  const title = /Intitulé : (.*)/.exec(req.prompt)?.[1] ?? 'ce poste';
  const company = /Entreprise : (.*)/.exec(req.prompt)?.[1] ?? 'votre entreprise';
  const english = /en anglais/.test(req.system ?? '');
  return {
    sections: keys.map((key, i) => ({
      key,
      paragraphs: [english ? (i === 0 ? `I am writing to apply for the position of ${title} at ${company}.` : `My experience described in my resume matches the needs set out in your posting for this section (${key}).`) : i === 0 ? `Je vous adresse ma candidature au poste de ${title} au sein de ${company}.` : `Mon parcours, décrit dans mon CV, répond aux besoins exprimés dans votre annonce (${key}).`],
    })),
    subject: english ? `Application — ${title}` : `Candidature — ${title}`,
    recipientName: '',
    notes: '',
  };
});

registerMock('letter.verify', () => ({ issues: [] }));
