import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { makeTestEnv, signedIn, type FetchMock, type TestEnv } from '../helpers.js';
import { forUser } from '../../src/core/context.js';
import { getSecret } from '../../src/core/secrets.js';
import { getSetting } from '../../src/core/settings.js';
import { applications, drafts, emails, interviews, jobs, secrets } from '../../src/db/schema.js';
import { ingestJob, manualSource } from '../../src/search/ingest.js';
import { checkFollowUps } from '../../src/tracker/followup.js';
import { SCOPE_COMPOSE, SCOPE_READ, parseMessage } from '../../src/tracker/gmail.js';
import { classifyByRules, isJobRelated, matchMail, parseAlert, syncMail } from '../../src/tracker/mail.js';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
const msg = (id: string, from: string, subject: string, text: string, html = '') => ({
  id,
  threadId: `t-${id}`,
  snippet: text.slice(0, 120),
  internalDate: String(Date.now() - 3600_000),
  payload: { mimeType: 'multipart/alternative', headers: [{ name: 'From', value: from }, { name: 'To', value: 'camille@example.test' }, { name: 'Subject', value: subject }, { name: 'Message-ID', value: `<${id}@mail.example>` }], parts: [{ mimeType: 'text/plain', body: { data: b64(text) } }, ...(html ? [{ mimeType: 'text/html', body: { data: b64(html) } }] : []), { mimeType: 'application/pdf', filename: 'piece-jointe.pdf', body: { data: b64('NE PAS LIRE') } }] },
});

const ALERT_HTML = `<table><tr><td><a href="https://www.linkedin.com/comm/jobs/view/3900000001/?trackingId=abc&refId=x">Transaction Services Associate<br>Aldgate Partners · Luxembourg</a></td></tr>
<tr><td><a href="https://www.linkedin.com/comm/jobs/view/3900000002/?trackingId=def">Financial Due Diligence Analyst</a><p>Corvin Partners · Paris, France</p></td></tr>
<tr><td><a href="https://www.linkedin.com/comm/jobs/view/3900000003/">Voir l'offre</a></td></tr><tr><td><a href="https://www.linkedin.com/help">Aide</a></td></tr></table>`;

const INBOX: Record<string, ReturnType<typeof msg>> = {
  m1: msg('m1', 'Northwind Capital <no-reply@greenhouse.io>', 'Thank you for applying to Northwind Capital', 'Hi Camille, thank you for applying to the Senior Analyst, Transaction Services role. We have received your application and will be in touch.'),
  m2: msg('m2', '"Recrutement Hartwell" <recrutement@hartwell-associes.example>', 'Votre candidature chez Hartwell & Associés', 'Bonjour, nous avons étudié votre candidature avec attention. Malheureusement, nous ne donnerons pas suite à celle-ci. Bien cordialement.'),
  m3: msg('m3', 'Julie Morel <julie.morel@northwind-capital.example>', 'Interview — Senior Analyst, Transaction Services', 'Dear Camille, we would like to invite you to a first interview with our team at Northwind Capital. Could you share your availability next week?'),
  m4: msg('m4', 'Salle de sport <news@fitclub.example>', 'Application update: your membership', 'Your gym application has been renewed. See you soon!'),
  m5: msg('m5', 'LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>', '2 new jobs for "transaction services"', 'New jobs match your alert', ALERT_HTML),
  m6: msg('m6', 'Paul Roche <paul.roche@valmont-advisory.example>', 'Valmont Advisory — quelques précisions', 'Bonjour, pourriez-vous nous indiquer vos prétentions salariales et votre préavis ? Merci.'),
};

const calls: { url: string; method: string; body: string; auth: string }[] = [];
let grantedScope = SCOPE_READ;
let refreshValid = true;
const net: FetchMock = (url, init) => {
  const u = new URL(url);
  const body = typeof init?.body === 'string' ? init.body : '';
  calls.push({ url, method: init?.method ?? 'GET', body, auth: String((init?.headers as Record<string, string> | undefined)?.authorization ?? '') });
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  if (u.host === 'oauth2.googleapis.com' && u.pathname === '/token') {
    const p = new URLSearchParams(body);
    if (p.get('client_secret') !== 'secret-google') return json({ error: 'invalid_client' }, 401);
    if (p.get('grant_type') === 'authorization_code') return p.get('code') === 'bon-code' && p.get('code_verifier') ? json({ access_token: 'acces-1', refresh_token: 'rafraichissement-1', scope: grantedScope, expires_in: 3600 }) : json({ error: 'invalid_grant', error_description: 'Bad Request' }, 400);
    return refreshValid && p.get('refresh_token') === 'rafraichissement-1' ? json({ access_token: 'acces-2', scope: grantedScope, expires_in: 3600 }) : json({ error: 'invalid_grant' }, 400);
  }
  if (u.host === 'oauth2.googleapis.com' && u.pathname === '/revoke') return json({});
  if (u.host === 'gmail.googleapis.com') {
    const path = u.pathname.replace('/gmail/v1/users/me', '');
    if (path === '/profile') return json({ emailAddress: 'camille@example.test' });
    if (path === '/messages') return json({ messages: Object.keys(INBOX).map((id) => ({ id })) });
    if (path.startsWith('/messages/')) return json(INBOX[path.split('/')[2]!]);
    if (path === '/drafts' && init?.method === 'POST') return json({ id: 'brouillon-gmail-1' });
  }
  return new Response('not found', { status: 404 });
};

let t: TestEnv;
let api: Awaited<ReturnType<typeof signedIn>>['api'];
let userId: string;
const uctx = () => forUser(t.ctx, userId);
const ids: Record<string, string> = {};
const stageOf = async (key: string) => (await t.ctx.db.select().from(jobs).where(eq(jobs.id, ids[key]!)))[0]!.stage;
const text = (topic: string) => `${topic}. ${'Vous analysez la performance financière des sociétés cibles pour des fonds. '.repeat(5)}`;

beforeAll(async () => {
  t = await makeTestEnv({ fetch: net });
  ({ api, userId } = await signedIn(t));
  const source = await manualSource(uctx());
  for (const [key, company, title] of [['northwind', 'Northwind Capital', 'Senior Analyst, Transaction Services'], ['hartwell', 'Hartwell & Associés', 'Consultant Transaction Services'], ['valmont', 'Valmont Advisory', 'Analyste M&A'], ['valmont2', 'Valmont Advisory', 'Contrôleur de gestion'], ['solene', 'Solène Conseil', 'Analyste FP&A']] as const) {
    const res = await ingestJob(uctx(), { company, title, location: 'Paris', descriptionText: text(title) }, { source });
    ids[key] = res.job.id;
    expect((await api.post(`/api/applications/${res.job.id}/submitted`, { channel: 'Site carrières' })).status).toBe(200);
  }
});
afterAll(() => t.close());

describe('lecture ciblée et classement', () => {
  it('ne retient que les messages liés à la recherche d’emploi', () => {
    const keys = ['northwind capital', 'hartwell&associes'];
    expect(isJobRelated({ fromAddr: 'no-reply@greenhouse.io', fromName: 'X', subject: 'Hello', snippet: '' }, keys)).toBe(true);
    expect(isJobRelated({ fromAddr: 'julie@northwind-capital.example', fromName: 'Julie', subject: 'Bonjour', snippet: 'Northwind Capital vous écrit' }, keys)).toBe(true);
    expect(isJobRelated({ fromAddr: 'ami@example.test', fromName: 'Un ami', subject: 'Dîner samedi ?', snippet: 'On se voit ?' }, keys)).toBe(false);
  });

  it('classe par règles les cas nets, dans plusieurs langues', () => {
    const c = (subject: string, body: string, from = 'x@y.example') => classifyByRules({ fromAddr: from, subject, text: body, snippet: '' })?.category;
    expect(c('Thank you for applying', 'We have received your application')).toBe('confirmation');
    expect(c('Votre candidature', 'Nous accusons réception de votre candidature')).toBe('confirmation');
    expect(c('Update', 'Unfortunately, we will not be moving forward with your application')).toBe('rejection');
    expect(c('Suite à notre échange', 'Nous souhaitons vous rencontrer pour un entretien')).toBe('interview');
    expect(c('Offer', 'We are pleased to offer you the position')).toBe('offer');
    expect(c('3 new jobs for you', '', 'jobalerts-noreply@linkedin.com')).toBe('job_alert');
    expect(classifyByRules({ fromAddr: 'x@y.example', subject: 'Bonjour', text: 'Belle journée', snippet: '' })).toBeNull();
    // Un refus qui parle d'entretien reste un refus.
    expect(c('Suite à votre entretien', 'Malheureusement, nous ne donnerons pas suite')).toBe('rejection');
  });

  it('lit le corps texte d’un message sans jamais ouvrir ses pièces jointes', () => {
    const parsed = parseMessage(INBOX.m1!);
    expect(parsed).toMatchObject({ fromAddr: 'no-reply@greenhouse.io', fromName: 'Northwind Capital', subject: 'Thank you for applying to Northwind Capital', messageId: '<m1@mail.example>' });
    expect(parsed.text).toContain('We have received your application');
    expect(parsed.text).not.toContain('NE PAS LIRE');
  });

  it('rattache un message à la candidature concernée, et signale l’ambiguïté', () => {
    const list = [
      { jobId: 'a', applicationId: 'A', companyName: 'Valmont Advisory', companyNorm: 'valmont advisory', title: 'Analyste M&A', stage: 'sent' as const, submittedAt: new Date() },
      { jobId: 'b', applicationId: 'B', companyName: 'Valmont Advisory', companyNorm: 'valmont advisory', title: 'Contrôleur de gestion', stage: 'sent' as const, submittedAt: new Date() },
      { jobId: 'c', applicationId: 'C', companyName: 'Northwind Capital', companyNorm: 'northwind capital', title: 'Senior Analyst, Transaction Services', stage: 'sent' as const, submittedAt: new Date() },
    ];
    const mail = (fromAddr: string, subject: string, body = '') => ({ fromAddr, fromName: '', subject, text: body });
    expect(matchMail(mail('no-reply@greenhouse.io', 'Thank you for applying to Northwind Capital'), { company: '', jobTitle: '' }, list)).toMatchObject({ job: { jobId: 'c' }, ambiguous: false });
    expect(matchMail(mail('julie@northwind-capital.example', 'Votre candidature'), { company: '', jobTitle: '' }, list).job?.jobId).toBe('c');
    expect(matchMail(mail('rh@valmont-advisory.example', 'Votre candidature au poste de Contrôleur de gestion'), { company: '', jobTitle: '' }, list)).toMatchObject({ job: { jobId: 'b' }, ambiguous: false });
    expect(matchMail(mail('rh@valmont-advisory.example', 'Quelques précisions'), { company: '', jobTitle: '' }, list).ambiguous).toBe(true);
    expect(matchMail(mail('x@inconnu.example', 'Bonjour'), { company: '', jobTitle: '' }, list).job).toBeNull();
  });

  it('lit les offres d’une alerte sans rien deviner', () => {
    expect(parseAlert(ALERT_HTML)).toEqual([
      { title: 'Transaction Services Associate', company: 'Aldgate Partners', location: 'Luxembourg', url: 'https://www.linkedin.com/comm/jobs/view/3900000001/?trackingId=abc&refId=x' },
      { title: 'Financial Due Diligence Analyst', company: 'Corvin Partners', location: 'Paris, France', url: 'https://www.linkedin.com/comm/jobs/view/3900000002/?trackingId=def' },
    ]);
  });
});

describe('connexion Gmail par OAuth', () => {
  let state = '';
  let cookie = '';

  it('exige l’identifiant et le secret du projet Google de l’utilisateur', async () => {
    expect((await api.post('/api/mail/gmail/start', { access: 'read' })).status).toBe(400);
    expect((await api.put('/api/settings/email.gmail', { value: { canRead: true } })).status).toBe(400); // les autorisations ne se déclarent pas
    expect((await api.put('/api/mail/gmail/settings', { clientId: '123-abc.apps.googleusercontent.com' })).status).toBe(200);
    expect((await api.put('/api/settings/secrets/google_client_secret', { value: 'secret-google' })).status).toBe(200);
  });

  it('demande la lecture seule, avec état signé et vérification PKCE', async () => {
    const res = await api.raw('POST', '/api/mail/gmail/start', { access: 'read' });
    expect(res.status).toBe(200);
    const url = new URL(res.data.url);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe(SCOPE_READ);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toMatch(/\/api\/mail\/gmail\/callback$/);
    state = url.searchParams.get('state')!;
    cookie = /ja_oauth=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
    expect(cookie.length).toBeGreaterThan(30);
    expect(res.headers.get('set-cookie')).toContain('HttpOnly');
  });

  it('refuse un retour forgé ou sans le secret de vérification', async () => {
    const forged = await api.raw('GET', `/api/mail/gmail/callback?code=bon-code&state=${state.slice(0, -3)}abc`, undefined, { cookie: `ja_oauth=${cookie}` });
    expect(forged.status).toBe(403);
    const noCookie = await api.get(`/api/mail/gmail/callback?code=bon-code&state=${state}`);
    expect(noCookie.status).toBe(403);
    expect(await getSecret(t.ctx.db, t.ctx.env.appSecret, userId, 'gmail_refresh_token')).toBeNull();
  });

  it('enregistre le jeton chiffré et les autorisations réellement accordées', async () => {
    const res = await api.raw('GET', `/api/mail/gmail/callback?code=bon-code&state=${state}`, undefined, { cookie: `ja_oauth=${cookie}` });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/parametres/messagerie?gmail=ok');
    expect(await getSecret(t.ctx.db, t.ctx.env.appSecret, userId, 'gmail_refresh_token')).toBe('rafraichissement-1');
    expect(await getSetting(t.ctx.db, userId, 'email.gmail')).toMatchObject({ canRead: true, canCompose: false, account: 'camille@example.test', allowSend: false });
    // Un code refusé par Google ne laisse aucune connexion à moitié faite.
    const again = await api.raw('POST', '/api/mail/gmail/start', { access: 'read' });
    const st = new URL(again.data.url).searchParams.get('state')!;
    const ck = /ja_oauth=([^;]+)/.exec(again.headers.get('set-cookie') ?? '')![1]!;
    const bad = await api.raw('GET', `/api/mail/gmail/callback?code=mauvais&state=${st}`, undefined, { cookie: `ja_oauth=${ck}` });
    expect(bad.headers.get('location')).toContain('gmail=erreur');
  });
});

describe('synchronisation et effets sur le suivi', () => {
  beforeAll(async () => {
    // Connexion établie directement (le parcours HTTP est couvert ci-dessus) : jeton chiffré + autorisation de lecture.
    const { finishAuth } = await import('../../src/tracker/gmail.js');
    const res = await finishAuth(uctx(), 'bon-code', 'verificateur');
    expect(res).toEqual({ account: 'camille@example.test', canRead: true, canCompose: false });
  });

  it('ne stocke jamais le jeton en clair et ne l’expose pas', async () => {
    const [row] = await t.ctx.db.select().from(secrets).where(and(eq(secrets.userId, userId), eq(secrets.key, 'gmail_refresh_token')));
    expect(row!.ciphertext).not.toContain('rafraichissement-1');
    const status = await api.get('/api/mail/status');
    expect(status.data.gmail).toMatchObject({ connected: true, canRead: true, canCompose: false, allowSend: false, account: 'camille@example.test' });
    expect(JSON.stringify(status.data)).not.toContain('rafraichissement-1');
    expect(JSON.stringify((await api.get('/api/settings')).data)).not.toContain('rafraichissement-1');
  });

  it('lit les messages utiles, met à jour le suivi et ne conserve rien d’autre', async () => {
    calls.length = 0;
    const res = await syncMail(uctx());
    expect(res).toMatchObject({ listed: 6, ignored: 1, alertJobs: 2 });
    // La recherche envoyée à Gmail est restreinte : mots-clés de candidature et entreprises suivies.
    const list = calls.find((c) => c.url.includes('/messages?'))!;
    const q = new URL(list.url).searchParams.get('q')!;
    expect(q).toMatch(/^after:\d+ /);
    expect(q).toContain('"Northwind Capital"');
    expect(q).toContain('candidature');
    expect(list.auth).toBe('Bearer acces-2');

    expect(await stageOf('northwind')).toBe('interview_hr'); // accusé de réception puis proposition d'entretien
    expect(await stageOf('hartwell')).toBe('rejected');
    const [app] = await t.ctx.db.select().from(applications).where(eq(applications.jobId, ids.northwind!));
    expect(app!.confirmedAt).toBeTruthy();
    expect((app!.confirmation as any).source).toBe('email');
    const [itv] = await t.ctx.db.select().from(interviews).where(eq(interviews.jobId, ids.northwind!));
    expect(itv).toMatchObject({ status: 'to_schedule', interviewer: 'Julie Morel' });
    const inbox = (await api.get('/api/inbox')).data.items;
    expect(inbox.some((i: any) => i.type === 'interview.detected' && i.jobId === ids.northwind)).toBe(true);

    const stored = await t.ctx.db.select().from(emails).where(eq(emails.userId, userId));
    expect(stored.map((e) => e.subject).sort()).not.toContain('Application update: your membership');
    expect(stored.find((e) => e.category === 'job_alert')!.bodyText).toBe(''); // une alerte n'est pas archivée
    // Deux candidatures chez la même entreprise : aucun effet automatique, l'utilisateur tranche.
    const ambiguous = stored.find((e) => e.subject.includes('quelques précisions'))!;
    expect(ambiguous.needsReview).toBe(true);
    expect(await stageOf('valmont')).toBe('sent');
    expect(inbox.some((i: any) => i.type === 'email.review' && i.body.emailId === ambiguous.id)).toBe(true);

    // Offres de l'alerte : fiches créées, texte à compléter avant toute analyse ATS.
    const fromAlert = (await t.ctx.db.select().from(jobs).where(eq(jobs.userId, userId))).filter((j) => (j.flags as any).fromAlert);
    expect(fromAlert.map((j) => j.companyName).sort()).toEqual(['Aldgate Partners', 'Corvin Partners']);
    expect(fromAlert[0]!.canonicalUrl).toMatch(/^https:\/\/www\.linkedin\.com\/jobs\/view\/39000000\d+$/);
    // Lecture seule : aucune écriture vers Gmail.
    expect(calls.filter((c) => c.url.includes('gmail.googleapis.com') && c.method !== 'GET')).toHaveLength(0);
  });

  it('une nouvelle synchronisation ne rejoue rien', async () => {
    const before = (await t.ctx.db.select().from(emails).where(eq(emails.userId, userId))).length;
    const res = await syncMail(uctx());
    expect(res.kept).toBe(0);
    expect((await t.ctx.db.select().from(emails).where(eq(emails.userId, userId))).length).toBe(before);
    expect(await t.ctx.db.select().from(interviews).where(eq(interviews.jobId, ids.northwind!))).toHaveLength(1);
  });

  it('applique la décision de l’utilisateur sur un email incertain', async () => {
    const [mail] = await t.ctx.db.select().from(emails).where(and(eq(emails.userId, userId), eq(emails.needsReview, true)));
    const res = await api.post(`/api/mail/emails/${mail!.id}/assign`, { jobId: ids.valmont, category: 'recruiter_request' });
    expect(res.data).toEqual({ ok: true, applied: true });
    expect((await t.ctx.db.select().from(emails).where(eq(emails.id, mail!.id)))[0]).toMatchObject({ needsReview: false, jobId: ids.valmont, matchMethod: 'utilisateur' });
    const overview = await api.get('/api/mail/overview');
    expect(overview.data.emails.length).toBeGreaterThanOrEqual(4);
    expect(overview.data.interviews).toHaveLength(1);
  });
});

describe('relances et brouillons', () => {
  it('prépare une relance à l’échéance, puis classe la candidature sans réponse', async () => {
    t.clock.advance(11 * 86400_000);
    const first = await checkFollowUps(uctx());
    expect(first.due).toBeGreaterThanOrEqual(1);
    expect(await stageOf('solene')).toBe('follow_up_needed');
    const [draft] = await t.ctx.db.select().from(drafts).where(and(eq(drafts.userId, userId), eq(drafts.jobId, ids.solene!)));
    expect(draft).toMatchObject({ kind: 'follow_up', status: 'draft' });
    expect((await api.get('/api/inbox')).data.items.some((i: any) => i.type === 'followup.due' && i.jobId === ids.solene)).toBe(true);
    // Les candidatures refusées ou en entretien ne sont jamais relancées.
    expect(await stageOf('hartwell')).toBe('rejected');
    expect(await stageOf('northwind')).toBe('interview_hr');
    // Pas de seconde relance avant l'échéance suivante.
    expect((await checkFollowUps(uctx())).due).toBe(0);
    t.clock.advance(36 * 86400_000);
    await checkFollowUps(uctx());
    expect(await stageOf('solene')).toBe('no_response');
  });

  it('ne dépose un brouillon dans Gmail qu’avec l’autorisation de rédaction, et n’envoie jamais', async () => {
    const [draft] = await t.ctx.db.select().from(drafts).where(and(eq(drafts.userId, userId), eq(drafts.jobId, ids.solene!)));
    await api.put(`/api/mail/drafts/${draft!.id}`, { toAddr: 'recrutement@solene.example' });
    const refused = await api.post(`/api/mail/drafts/${draft!.id}/push`);
    expect(refused.status).toBe(400);
    expect(refused.data.error.message).toContain('autorisation de rédaction');
    expect((await api.put('/api/mail/gmail/settings', { allowSend: true })).status).toBe(409);
    // L'utilisateur accorde la rédaction (seconde autorisation, distincte).
    grantedScope = `${SCOPE_READ} ${SCOPE_COMPOSE}`;
    const { finishAuth } = await import('../../src/tracker/gmail.js');
    expect((await finishAuth(uctx(), 'bon-code', 'verificateur')).canCompose).toBe(true);
    calls.length = 0;
    const pushed = await api.post(`/api/mail/drafts/${draft!.id}/push`);
    expect(pushed.data).toEqual({ gmailDraftId: 'brouillon-gmail-1' });
    const write = calls.filter((c) => c.url.includes('gmail.googleapis.com') && c.method === 'POST');
    expect(write.map((c) => new URL(c.url).pathname)).toEqual(['/gmail/v1/users/me/drafts']);
    const raw = Buffer.from(JSON.parse(write[0]!.body).message.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    expect(raw).toContain('To: recrutement@solene.example');
    expect(calls.some((c) => /\/send\b/.test(c.url))).toBe(false);
    expect((await getSetting(t.ctx.db, userId, 'email.gmail')).allowSend).toBe(false);
  });

  it('constate un accès retiré chez Google et révoque proprement à la demande', async () => {
    refreshValid = false;
    await expect(syncMail(uctx())).rejects.toThrow(/reconnectez votre compte/);
    expect((await getSetting(t.ctx.db, userId, 'email.gmail')).canRead).toBe(false);
    refreshValid = true;
    const { finishAuth } = await import('../../src/tracker/gmail.js');
    await finishAuth(uctx(), 'bon-code', 'verificateur');
    calls.length = 0;
    expect((await api.post('/api/mail/gmail/disconnect')).status).toBe(200);
    expect(calls.some((c) => c.url.startsWith('https://oauth2.googleapis.com/revoke?token=rafraichissement-1'))).toBe(true);
    expect(await getSecret(t.ctx.db, t.ctx.env.appSecret, userId, 'gmail_refresh_token')).toBeNull();
    expect((await api.get('/api/mail/status')).data.gmail).toMatchObject({ connected: false, canRead: false, canCompose: false });
    // Les emails déjà rattachés restent dans le suivi.
    expect((await t.ctx.db.select().from(emails).where(eq(emails.userId, userId))).length).toBeGreaterThan(3);
  });
});
