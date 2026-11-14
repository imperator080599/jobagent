// Suivi des réponses par email : lecture ciblée de Gmail, classement des messages,
// rattachement à la bonne candidature, mise à jour du suivi et préparation des réponses.
//  - Seuls les messages liés à la recherche d'emploi sont lus puis conservés.
//  - Le contenu d'un email est une donnée externe : il ne peut modifier aucune règle.
//  - Aucune réponse n'est envoyée : au mieux un brouillon, que l'utilisateur relit.
//  - Un rattachement incertain n'a aucun effet automatique : il est soumis à l'utilisateur.
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { parse as parseHtml } from 'node-html-parser';
import { z } from 'zod';
import type { UserContext } from '../core/context.js';
import { logActivity } from '../core/activity.js';
import { raiseAction, resolveActionsFor } from '../core/inbox.js';
import { enqueue } from '../core/queue.js';
import { getSetting } from '../core/settings.js';
import { normalize } from '../core/text.js';
import { newId } from '../db/ids.js';
import { applications, drafts, emails, interviews, jobs, sources } from '../db/schema.js';
import { getLlm, llmAvailability, UNTRUSTED_RULE, wrapUntrusted } from '../llm/index.js';
import { registerMock } from '../llm/mock.js';
import { ingestJob, type Source } from '../search/ingest.js';
import { companyKey } from '../search/normalize.js';
import { titleAffinity } from '../search/synonyms.js';
import { isSubmitted, type Stage } from '../shared/stages.js';
import { getLastRun, setLastRun } from '../pipeline/scheduler.js';
import { type GmailMessage, type ParsedMail, createDraft, gmailClient, parseMessage } from './gmail.js';
import { setStage } from './stage.js';

export type MailCategory = 'confirmation' | 'interview' | 'rejection' | 'offer' | 'recruiter_request' | 'job_alert' | 'other';
export const MAIL_LABELS: Record<MailCategory, string> = { confirmation: 'Accusé de réception', interview: "Proposition d'entretien", rejection: 'Refus', offer: "Proposition d'embauche", recruiter_request: 'Demande du recruteur', job_alert: "Alerte d'offres", other: 'Autre' };

const ALERT_SENDERS = /(jobalerts?-noreply@linkedin\.com|jobs-listings@linkedin\.com|jobs-noreply@linkedin\.com|alert@indeed\.com|no-?reply@indeed\.com|@jobalert\.indeed\.com|alerts?@welcometothejungle\.com|@apec\.fr|@cadremploi\.fr|@hellowork\.com|@jobteaser\.com|@efinancialcareers\.|@glassdoor\.com|civiweb|businessfrance|@monster\.|@francetravail\.fr|@pole-emploi\.fr)/i;
const ATS_SENDERS = /(greenhouse(-mail)?\.io|lever\.co|hire\.lever|smartrecruiters\.com|myworkday(jobs)?\.com|workday\.com|successfactors|taleo\.net|icims\.com|ashbyhq\.com|teamtailor(-mail)?\.com|recruitee\.com|workable(mail)?\.com|personio\.|jobvite\.com|bamboohr\.com|talentsoft|cornerstone|avature\.net|welcomekit|flatchr|beetween|digitalrecruiters|softy\.pro)/i;
const JOB_WORDS = /(candidature|application|applying|applied|entretien|interview|recrutement|recruit|recruiter|recruteur|talent acquisition|hiring|poste de|position of|job offer|offre d'emploi|votre profil|your profile|bewerbung)/i;

const RULES: { category: MailCategory; re: RegExp; confidence: number }[] = [
  { category: 'offer', confidence: 0.85, re: /(pleased to (offer|extend)|delighted to offer|offer letter|formal offer|proposition d'embauche|promesse d'embauche|heureux de vous proposer (le|un) (poste|contrat)|votre contrat de travail)/i },
  { category: 'rejection', confidence: 0.9, re: /(unfortunately|we regret|regret to inform|not (be )?(moving|proceeding) forward|decided not to (proceed|move)|will not be (progressing|moving)|other candidates|not been (selected|successful)|malheureusement|ne (donnerons|pouvons|sommes) pas (en mesure )?(de )?(donner )?suite|n'a pas été retenue?|n'avons pas retenu|pas retenu votre|regrettons|sommes au regret|leider|absage)/i },
  { category: 'interview', confidence: 0.85, re: /(interview|entretien|échange téléphonique|phone (screen|call)|video call|visio|schedule (a|an|your)|vos disponibilités|your availabilit|invitation to|convier|calendly\.com|rencontrer (notre|l')|case study|étude de cas|assessment (day|centre)|vorstellungsgespräch)/i },
  { category: 'confirmation', confidence: 0.9, re: /(thank(s| you) for (applying|your (application|interest))|(have |has been )?received your application|application (has been |was )?(received|submitted)|successfully (applied|submitted)|bien reçu votre candidature|accusons (bonne )?réception|avons bien reçu|candidature (a bien été|est bien) (reçue|enregistrée|prise en compte)|merci (pour|de) (votre candidature|l'intérêt)|ihre bewerbung ist eingegangen|confirmation de (votre )?candidature)/i },
  { category: 'recruiter_request', confidence: 0.7, re: /(could you (please )?(send|share|provide|confirm|let)|please (send|provide|confirm|share|complete)|pourriez-vous|pouvez-vous (nous|me)|merci de (nous |me )?(transmettre|envoyer|préciser|confirmer|indiquer|compléter)|quelles sont vos (prétentions|disponibilités)|salary expectations|prétentions salariales|notice period|préavis)/i },
];

/** Classement par règles. `null` quand rien de net : le modèle économique est alors consulté. */
export function classifyByRules(m: Pick<ParsedMail, 'fromAddr' | 'subject' | 'text' | 'snippet'>): { category: MailCategory; confidence: number } | null {
  if (ALERT_SENDERS.test(m.fromAddr) || /(job alert|alerte emploi|nouvelles? offres? (d'emploi|pour vous|correspond)|new jobs? (for you|matching|match)|\d+ (new )?jobs? for|offres qui pourraient vous)/i.test(m.subject)) return { category: 'job_alert', confidence: 0.9 };
  const hay = `${m.subject}\n${(m.text || m.snippet).slice(0, 3000)}`;
  for (const r of RULES) if (r.re.test(hay)) return { category: r.category, confidence: r.category === 'interview' && /unfortunately|malheureusement/i.test(hay) ? 0.5 : r.confidence };
  return null;
}

/** Le message concerne-t-il la recherche d'emploi ? Sinon il n'est ni analysé ni conservé. */
export function isJobRelated(m: Pick<ParsedMail, 'fromAddr' | 'fromName' | 'subject' | 'snippet'>, companyKeys: string[]): boolean {
  if (ALERT_SENDERS.test(m.fromAddr) || ATS_SENDERS.test(m.fromAddr)) return true;
  const hay = normalize(`${m.fromName} ${m.fromAddr.split('@')[1] ?? ''} ${m.subject} ${m.snippet}`);
  if (JOB_WORDS.test(`${m.subject} ${m.snippet}`)) return true;
  return companyKeys.some((k) => k.length > 2 && hay.includes(k.replace(/&/g, ' and ')));
}

const MailOut = z.object({
  category: z.enum(['confirmation', 'interview', 'rejection', 'offer', 'recruiter_request', 'job_alert', 'other']),
  confidence: z.number().min(0).max(1),
  company: z.string().describe("Entreprise qui recrute, telle qu'elle apparaît dans le message. Chaîne vide si absente."),
  jobTitle: z.string().describe('Intitulé du poste cité dans le message. Chaîne vide si absent.'),
  summary: z.string().describe("Une phrase : ce que dit le message et ce qu'il attend du candidat."),
  needsReply: z.boolean(),
  proposedDate: z.string().describe("Date et heure d'entretien proposées, au format ISO 8601 si elles sont explicites ; sinon chaîne vide."),
});
type MailOut = z.infer<typeof MailOut>;

const MAIL_SYSTEM = `Tu classes un email reçu par un candidat en recherche d'emploi.
Catégories : confirmation (accusé de réception d'une candidature) ; interview (proposition ou organisation d'un entretien, d'un test ou d'une étude de cas) ; rejection (refus) ; offer (proposition d'embauche) ; recruiter_request (un recruteur demande une information, un document ou une disponibilité) ; job_alert (liste d'offres envoyée automatiquement) ; other (sans rapport avec une candidature).
Appuie-toi uniquement sur le message. N'invente ni entreprise ni intitulé : rends une chaîne vide si l'information n'y est pas.
${UNTRUSTED_RULE}`;

export async function classifyMail(ctx: UserContext, m: ParsedMail): Promise<MailOut & { method: 'rules' | 'llm' }> {
  const byRules = classifyByRules(m);
  const base: MailOut = { category: byRules?.category ?? 'other', confidence: byRules?.confidence ?? 0.3, company: '', jobTitle: '', summary: m.snippet.slice(0, 200), needsReply: byRules?.category === 'recruiter_request' || byRules?.category === 'interview', proposedDate: '' };
  if (byRules?.category === 'job_alert' || !(await llmAvailability(ctx)).available) return { ...base, method: 'rules' };
  try {
    const llm = await getLlm(ctx);
    const res = await llm.json({ purpose: 'mail.classify', tier: 'bulk', system: MAIL_SYSTEM, prompt: wrapUntrusted('email', `De : ${m.fromName} <${m.fromAddr}>\nObjet : ${m.subject}\n\n${m.text.slice(0, 6000)}`), schema: MailOut, maxTokens: 500, effort: 'low' });
    // Une règle nette (refus, accusé de réception) n'est pas contredite par le modèle : en cas de désaccord, la confiance baisse et l'utilisateur tranche.
    if (byRules && byRules.confidence >= 0.85 && res.data.category !== byRules.category) return { ...res.data, category: byRules.category, confidence: 0.55, method: 'llm' };
    return { ...res.data, method: 'llm' };
  } catch (err) {
    ctx.log.warn('mail_classify_failed', { error: String(err) });
    return { ...base, method: 'rules' };
  }
}

type Candidate = { jobId: string; applicationId: string | null; companyName: string; companyNorm: string; title: string; stage: Stage; submittedAt: Date | null };

async function candidates(ctx: UserContext): Promise<Candidate[]> {
  const rows = await ctx.db
    .select({ jobId: jobs.id, applicationId: applications.id, companyName: jobs.companyName, companyNorm: jobs.companyNorm, title: jobs.title, stage: jobs.stage, submittedAt: applications.submittedAt })
    .from(jobs)
    .leftJoin(applications, and(eq(applications.jobId, jobs.id), eq(applications.userId, ctx.userId)))
    .where(and(eq(jobs.userId, ctx.userId), inArray(jobs.stage, ['ready_to_apply', 'applying', 'sent', 'confirmed', 'follow_up_needed', 'no_response', 'interview_hr', 'interview_tech', 'offer', 'rejected'])))
    .orderBy(desc(jobs.stageChangedAt))
    .limit(400);
  return rows;
}

export interface MailMatch {
  job: Candidate | null;
  method: string;
  /** Plusieurs candidatures possibles (même entreprise) : l'utilisateur devra choisir. */
  ambiguous: boolean;
}

/** Rattache un message à une candidature : entreprise (expéditeur, objet, texte) puis intitulé du poste. */
export function matchMail(m: Pick<ParsedMail, 'fromAddr' | 'fromName' | 'subject' | 'text'>, hint: { company: string; jobTitle: string }, list: Candidate[]): MailMatch {
  const domain = normalize((m.fromAddr.split('@')[1] ?? '').replace(/\.(com|fr|co|io|net|org|eu|lu|ch|de|uk|be)\b/g, ' '));
  const head = normalize(`${m.fromName} ${m.subject} ${hint.company}`);
  const body = normalize(m.text.slice(0, 4000));
  const scored = list
    .map((c) => {
      const key = c.companyNorm.replace(/&/g, ' and ');
      const compact = key.replace(/\s+/g, '');
      let score = 0;
      if (key.length > 2 && head.includes(key)) score += 3;
      else if (compact.length > 3 && domain.replace(/\s+/g, '').includes(compact)) score += 3;
      else if (key.length > 2 && body.includes(key)) score += 2;
      if (hint.company && companyKey(hint.company) === c.companyNorm) score += 2;
      const title = titleAffinity(`${m.subject} ${hint.jobTitle} ${m.text.slice(0, 1500)}`, [c.title]);
      if (score > 0 && title >= 0.8) score += 2;
      else if (score > 0 && title >= 0.5) score += 1;
      return { c, score, title };
    })
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score || Number(isSubmitted(b.c.stage)) - Number(isSubmitted(a.c.stage)));
  if (!scored.length) return { job: null, method: '', ambiguous: false };
  const [best, second] = scored;
  const ambiguous = Boolean(second && second.score === best!.score && second.c.jobId !== best!.c.jobId);
  return { job: best!.c, method: best!.title >= 0.8 ? 'entreprise et intitulé' : 'entreprise', ambiguous };
}

const AFTER: Partial<Record<MailCategory, Stage>> = { confirmation: 'confirmed', interview: 'interview_hr', rejection: 'rejected', offer: 'offer' };

/** Applique au suivi ce que dit un email rattaché avec certitude. */
export async function applyMailEffects(ctx: UserContext, email: typeof emails.$inferSelect, job: Candidate, category: MailCategory, info: { summary: string; proposedDate: string }): Promise<void> {
  const now = ctx.now();
  const label = `${job.companyName} — ${job.title}`;
  if (job.applicationId) await ctx.db.update(applications).set({ lastActivityAt: email.date ?? now, updatedAt: now }).where(eq(applications.id, job.applicationId));
  const target = AFTER[category];
  if (category === 'confirmation') {
    if (job.applicationId) await ctx.db.update(applications).set({ confirmation: { text: email.snippet, source: 'email', emailId: email.id, at: (email.date ?? now).toISOString() }, confirmedAt: email.date ?? now }).where(eq(applications.id, job.applicationId));
    if (job.stage === 'sent') await setStage(ctx, job.jobId, 'confirmed', { actor: 'agent:email', reason: 'accusé de réception reçu par email', soft: true });
    return;
  }
  if (target && isSubmitted(job.stage)) await setStage(ctx, job.jobId, target, { actor: 'agent:email', reason: MAIL_LABELS[category].toLowerCase(), soft: true });
  if (category === 'rejection') {
    if (job.applicationId) await ctx.db.update(applications).set({ outcome: 'rejected', outcomeAt: email.date ?? now, followUpDueAt: null }).where(eq(applications.id, job.applicationId));
    await resolveActionsFor(ctx.db, ctx.userId, { jobId: job.jobId, types: ['followup.due'] }, { rejected: true });
    return;
  }
  if (category === 'interview') {
    const when = info.proposedDate ? new Date(info.proposedDate) : null;
    const [existing] = await ctx.db.select({ id: interviews.id }).from(interviews).where(and(eq(interviews.userId, ctx.userId), eq(interviews.jobId, job.jobId), eq(interviews.sourceEmailId, email.id)));
    if (!existing) await ctx.db.insert(interviews).values({ id: newId('itv'), userId: ctx.userId, jobId: job.jobId, applicationId: job.applicationId, kind: 'hr', scheduledAt: when && !Number.isNaN(when.getTime()) ? when : null, status: when && !Number.isNaN(when.getTime()) ? 'scheduled' : 'to_schedule', sourceEmailId: email.id, interviewer: email.fromName });
    if (job.applicationId) await ctx.db.update(applications).set({ followUpDueAt: null }).where(eq(applications.id, job.applicationId));
    await raiseAction(ctx.db, { userId: ctx.userId, type: 'interview.detected', title: `Entretien proposé : ${label}`, body: { text: info.summary || email.snippet, link: `/offres/${job.jobId}`, emailId: email.id, from: email.fromName || email.fromAddr }, jobId: job.jobId, priority: 96, dedupKey: `interview:${email.id}` });
    return;
  }
  if (category === 'offer') {
    await raiseAction(ctx.db, { userId: ctx.userId, type: 'interview.detected', title: `Proposition d'embauche : ${label}`, body: { text: info.summary || email.snippet, link: `/offres/${job.jobId}`, emailId: email.id }, jobId: job.jobId, priority: 99, dedupKey: `offer:${email.id}` });
    return;
  }
  if (category === 'recruiter_request') {
    await raiseAction(ctx.db, { userId: ctx.userId, type: 'email.review', title: `Le recruteur attend une réponse : ${label}`, body: { text: info.summary || email.snippet, link: '/suivi', emailId: email.id, from: email.fromName || email.fromAddr }, jobId: job.jobId, priority: 90, dedupKey: `mail.reply:${email.id}` });
  }
}

// ── Alertes d'offres reçues par email ──

export interface AlertJob {
  title: string;
  company: string;
  location: string;
  url: string;
}

const JOB_LINK = /(linkedin\.com\/(comm\/)?jobs\/view\/|indeed\.[a-z.]+\/(rc\/clk|viewjob|pagead\/clk)|welcometothejungle\.com\/[^"]*\/jobs\/|apec\.fr\/[^"]*offre|cadremploi\.fr\/[^"]*offre|hellowork\.com\/[^"]*emplois?\/|jobteaser\.com\/[^"]*job-offers\/|efinancialcareers\.[^"]*\/jobs?-|glassdoor\.[^"]*job-listing|mon-vie-via\.businessfrance\.fr\/[^"]*offres?\/|civiweb\.com\/[^"]*offre|monster\.[a-z.]+\/[^"]*(emploi|job-openings|offre)|francetravail\.fr\/[^"]*offres?\/recherche\/detail)/i;
const GENERIC = /^(voir|view|see|apply|postuler|en savoir plus|learn more|afficher|consulter|découvrir)\b/i;

/** Offres citées dans un email d'alerte : lien, intitulé, entreprise, lieu. Une entrée sans entreprise lisible est ignorée (rien n'est deviné). */
export function parseAlert(html: string): AlertJob[] {
  const root = parseHtml(html);
  const out = new Map<string, AlertJob>();
  for (const a of root.querySelectorAll('a')) {
    const href = a.getAttribute('href') ?? '';
    if (!JOB_LINK.test(href)) continue;
    const lines = a.structuredText.split('\n').map((l) => l.trim()).filter(Boolean);
    let [title, second] = lines;
    if (!title || title.length < 4 || title.length > 140 || GENERIC.test(title)) continue;
    if (!second) {
      // Entreprise et lieu dans l'élément suivant du même bloc (mise en page en tableau des alertes).
      const cell = a.closest('td') ?? a.parentNode;
      const rest = (cell?.structuredText ?? '').split('\n').map((l: string) => l.trim()).filter(Boolean);
      second = rest[rest.indexOf(title) + 1];
    }
    if (!second || second === title) continue;
    const [company, location] = second.split(/\s+[·•|–-]\s+/);
    if (!company || company.length > 80) continue;
    const key = href.replace(/[?&](trk|trackingId|refId|lipi|midToken|midSig|eid|otpToken|utm_[a-z]+)=[^&]*/gi, '');
    if (!out.has(key)) out.set(key, { title, company: company.trim(), location: (location ?? '').trim(), url: href });
  }
  return [...out.values()];
}

async function alertSource(ctx: UserContext): Promise<Source> {
  const [existing] = await ctx.db.select().from(sources).where(and(eq(sources.userId, ctx.userId), eq(sources.type, 'email')));
  if (existing) return existing;
  const [created] = await ctx.db.insert(sources).values({ id: newId('src'), userId: ctx.userId, type: 'email', name: 'Alertes email', config: {}, intervalMinutes: 0, health: 'ok' }).returning();
  return created!;
}

async function importAlert(ctx: UserContext, m: ParsedMail): Promise<number> {
  if (!m.html) return 0;
  const source = await alertSource(ctx);
  let created = 0;
  for (const j of parseAlert(m.html).slice(0, 40)) {
    try {
      const res = await ingestJob(ctx, { url: j.url, company: j.company, title: j.title, location: j.location, descriptionText: '', postedAt: m.date }, { source, actor: 'agent:email', flags: { partialDescription: true, fromAlert: true } });
      if (res.outcome === 'created') {
        created++;
        await enqueue(ctx.db, { type: 'job.qualify', userId: ctx.userId, payload: { jobId: res.job.id }, idempotencyKey: `job.qualify:${res.job.id}`, priority: 35, runAfter: ctx.now() });
      }
    } catch (err) {
      ctx.log.warn('alert_job_failed', { error: String(err) });
    }
  }
  return created;
}

// ── Synchronisation ──

export interface MailSyncResult {
  listed: number;
  kept: number;
  ignored: number;
  matched: number;
  toReview: number;
  alertJobs: number;
}

export async function syncMail(ctx: UserContext, opts: { maxMessages?: number } = {}): Promise<MailSyncResult> {
  const cfg = await getSetting(ctx.db, ctx.userId, 'email.gmail');
  const client = await gmailClient(ctx);
  const list = await candidates(ctx);
  const companyKeys = [...new Set(list.map((c) => c.companyNorm))];
  const last = await getLastRun(ctx, ctx.userId, 'mail.cursor');
  const now = ctx.now();
  const since = last ? new Date(last.getTime() - 3600_000) : new Date(now.getTime() - cfg.lookbackDays * 86400_000);
  // Requête restreinte côté Gmail : le reste de la boîte n'est jamais lu.
  const names = [...new Set(list.map((c) => c.companyName.replace(/["()]/g, ' ').trim()))].filter((n) => n.length > 2).slice(0, 25);
  const words = ['candidature', 'application', 'applying', 'entretien', 'interview', 'recrutement', 'recruiting', 'recruiter', 'recruteur', '"offre d\'emploi"', '"job alert"', '"alerte emploi"', ...names.map((n) => `"${n}"`)];
  const q = `after:${Math.floor(since.getTime() / 1000)} -in:chats -in:drafts -in:sent (${words.join(' OR ')} OR from:(greenhouse.io OR lever.co OR smartrecruiters.com OR myworkday.com OR ashbyhq.com OR teamtailor.com OR linkedin.com OR indeed.com OR welcometothejungle.com))`;
  const ids: string[] = [];
  let pageToken = '';
  const max = opts.maxMessages ?? 300;
  do {
    const page = await client.get<{ messages?: { id: string }[]; nextPageToken?: string }>(`/messages?maxResults=100&q=${encodeURIComponent(q)}${pageToken ? `&pageToken=${pageToken}` : ''}`);
    ids.push(...(page.messages ?? []).map((m) => m.id));
    pageToken = page.nextPageToken ?? '';
  } while (pageToken && ids.length < max);
  const known = new Set((await ctx.db.select({ extracted: emails.extracted }).from(emails).where(and(eq(emails.userId, ctx.userId), gte(emails.createdAt, new Date(since.getTime() - 7 * 86400_000))))).map((e) => (e.extracted as { gmailId?: string } | null)?.gmailId));
  const res: MailSyncResult = { listed: ids.length, kept: 0, ignored: 0, matched: 0, toReview: 0, alertJobs: 0 };
  for (const id of ids.slice(0, max)) {
    if (known.has(id)) continue;
    const mail = parseMessage(await client.get<GmailMessage>(`/messages/${id}?format=full`));
    if (!isJobRelated(mail, companyKeys)) {
      res.ignored++;
      continue;
    }
    const cls = await classifyMail(ctx, mail);
    if (cls.category === 'other' && cls.method === 'llm') {
      res.ignored++;
      continue;
    }
    if (cls.category === 'job_alert') {
      if (cfg.importAlerts) res.alertJobs += await importAlert(ctx, mail);
      res.kept++;
      await ctx.db.insert(emails).values({ id: newId('eml'), userId: ctx.userId, messageId: mail.messageId, threadKey: mail.threadId, fromAddr: mail.fromAddr, fromName: mail.fromName, subject: mail.subject, date: mail.date, snippet: mail.snippet.slice(0, 300), bodyText: '', category: 'job_alert', confidence: cls.confidence, extracted: { gmailId: id }, processedAt: now }).onConflictDoNothing();
      continue;
    }
    const match = matchMail(mail, { company: cls.company, jobTitle: cls.jobTitle }, list);
    const sure = Boolean(match.job) && !match.ambiguous && cls.confidence >= 0.7;
    const [row] = await ctx.db
      .insert(emails)
      .values({ id: newId('eml'), userId: ctx.userId, messageId: mail.messageId, threadKey: mail.threadId, fromAddr: mail.fromAddr, fromName: mail.fromName, subject: mail.subject, date: mail.date, snippet: mail.snippet.slice(0, 300), bodyText: mail.text.slice(0, 8000), category: cls.category, confidence: cls.confidence, applicationId: match.job?.applicationId ?? null, jobId: match.job?.jobId ?? null, matchMethod: match.method, extracted: { gmailId: id, summary: cls.summary, company: cls.company, jobTitle: cls.jobTitle, proposedDate: cls.proposedDate, needsReply: cls.needsReply, method: cls.method }, needsReview: !sure, processedAt: now })
      .onConflictDoNothing()
      .returning();
    if (!row) continue;
    res.kept++;
    if (sure) {
      res.matched++;
      await applyMailEffects(ctx, row, match.job!, cls.category, { summary: cls.summary, proposedDate: cls.proposedDate });
    } else {
      res.toReview++;
      await raiseAction(ctx.db, { userId: ctx.userId, type: 'email.review', title: `Email à rattacher : ${mail.subject.slice(0, 90) || mail.fromName}`, body: { text: `${MAIL_LABELS[cls.category]} probable, de ${mail.fromName || mail.fromAddr}. ${match.ambiguous ? 'Plusieurs candidatures correspondent à cette entreprise.' : match.job ? 'Le classement est incertain.' : "Aucune candidature n'a pu être identifiée."}`, link: '/suivi', emailId: row.id }, jobId: match.job?.jobId ?? null, priority: cls.category === 'interview' || cls.category === 'offer' ? 93 : 70, dedupKey: `mail.review:${row.id}` });
    }
  }
  await setLastRun(ctx, ctx.userId, 'mail.cursor', now);
  await logActivity(ctx.db, { userId: ctx.userId, actor: 'agent:email', action: 'mail.sync', summary: `Messagerie : ${res.kept} message(s) lié(s) à vos candidatures, ${res.matched} rattaché(s) automatiquement, ${res.toReview} à vérifier${res.alertJobs ? `, ${res.alertJobs} offre(s) importée(s) depuis vos alertes` : ''}`, data: { ...res } });
  return res;
}

// ── Réponses et relances préparées ──

const DraftOut = z.object({ subject: z.string(), body: z.string().describe('Corps du message, prêt à être relu : formule d\'appel, deux à six phrases, formule de politesse, sans signature inventée.') });
const DRAFT_SYSTEM = `Tu prépares un email court qu'un candidat relira avant de l'envoyer lui-même. Ton professionnel, direct, sans flatterie ni formule creuse. Langue : celle du message reçu ou de l'annonce.
N'invente aucune information : si une donnée demandée (disponibilité, prétentions, préavis) n'est pas fournie dans les informations validées, laisse la mention « [à compléter] » à cet endroit.
${UNTRUSTED_RULE}`;

export type Draft = typeof drafts.$inferSelect;

export async function prepareDraft(ctx: UserContext, input: { kind: Draft['kind']; jobId: string; applicationId?: string | null; emailId?: string | null; to?: string; context: string; facts?: string; signature: string }): Promise<Draft> {
  const llm = await getLlm(ctx);
  const res = await llm.json({ purpose: input.kind === 'follow_up' ? 'mail.followup' : 'mail.reply', tier: 'bulk', system: DRAFT_SYSTEM, prompt: `${input.facts ? `Informations validées du candidat :\n${input.facts}\n\n` : ''}Signature : ${input.signature}\n\n${input.context}`, schema: DraftOut, maxTokens: 700, effort: 'low', jobId: input.jobId });
  const [row] = await ctx.db.insert(drafts).values({ id: newId('dft'), userId: ctx.userId, kind: input.kind, jobId: input.jobId, applicationId: input.applicationId ?? null, emailId: input.emailId ?? null, toAddr: input.to ?? '', subject: res.data.subject.slice(0, 300), body: res.data.body, status: 'draft' }).returning();
  return row!;
}

/** Dépose le brouillon dans Gmail (dossier Brouillons). Rien n'est envoyé. */
export async function pushDraft(ctx: UserContext, draftId: string): Promise<{ gmailDraftId: string }> {
  const [d] = await ctx.db.select().from(drafts).where(and(eq(drafts.id, draftId), eq(drafts.userId, ctx.userId)));
  if (!d) throw new Error('Brouillon introuvable.');
  let threadId: string | undefined;
  let inReplyTo: string | undefined;
  if (d.emailId) {
    const [e] = await ctx.db.select().from(emails).where(and(eq(emails.id, d.emailId), eq(emails.userId, ctx.userId)));
    threadId = e?.threadKey || undefined;
    inReplyTo = e?.messageId.startsWith('gmail:') ? undefined : e?.messageId;
  }
  const gmailDraftId = await createDraft(ctx, { to: d.toAddr, subject: d.subject, body: d.body, threadId, inReplyTo });
  await ctx.db.update(drafts).set({ status: 'approved', updatedAt: ctx.now() }).where(eq(drafts.id, d.id));
  return { gmailDraftId };
}

registerMock('mail.classify', (req) => {
  const text = req.prompt;
  const cls = classifyByRules({ fromAddr: /<([^>]+)>/.exec(text)?.[1] ?? '', subject: /Objet : (.*)/.exec(text)?.[1] ?? '', text, snippet: '' });
  return { category: cls?.category ?? 'other', confidence: cls?.confidence ?? 0.4, company: '', jobTitle: '', summary: 'Simulation : classement par règles.', needsReply: cls?.category === 'recruiter_request', proposedDate: '' };
});
registerMock('mail.reply', () => ({ subject: 'Re: votre message', body: 'Bonjour,\n\nJe vous remercie pour votre message. [à compléter]\n\nBien cordialement,' }));
registerMock('mail.followup', (req) => ({ subject: `Candidature — ${/Poste : (.*)/.exec(req.prompt)?.[1] ?? 'suivi'}`, body: "Bonjour,\n\nJe me permets de revenir vers vous au sujet de ma candidature, pour laquelle je reste très intéressé. Je me tiens à votre disposition pour tout échange.\n\nBien cordialement," }));
