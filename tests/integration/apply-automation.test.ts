// Moteur de candidature, sur des formulaires de DÉMONSTRATION servis localement (structure
// des formulaires publics Greenhouse, Lever, Workday, Ashby, Workable, Taleo). Aucun site
// réel n'est contacté et aucune candidature n'est adressée à un recruteur.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { chromium, type Browser } from 'playwright-core';
import { makeTestEnv, signedIn, type TestEnv } from '../helpers.js';
import { DEMO_URLS, installDemoAts, type DemoStore } from '../fixtures/ats-demo.js';
import { forUser } from '../../src/core/context.js';
import { saveFile } from '../../src/core/files.js';
import { getSetting, setSetting } from '../../src/core/settings.js';
import { newId } from '../../src/db/ids.js';
import { actionItems, applicationAttempts, applications, cvVersions, jobs } from '../../src/db/schema.js';
import { answerQuestions, automationMetrics, planAutomation, runAutomation } from '../../src/apply/automation.js';
import { detectPlatform } from '../../src/apply/platforms.js';
import { runApplication } from '../../src/apply/engine/runner.js';
import { resolveFields } from '../../src/apply/resolve.js';
import { setFact } from '../../src/profile/facts.js';
import { createApiToken } from '../../src/auth/service.js';

const FIXTURE = 'tests/fixtures/cv/camille-durand.pdf';
const PDF = readFileSync(FIXTURE);
const PDF_SHA = createHash('sha256').update(PDF).digest('hex');

let t: TestEnv;
let userId: string;
let api: Awaited<ReturnType<typeof signedIn>>['api'];
let browser: Browser;
let masterId = '';
let store: DemoStore;
const uctx = () => forUser(t.ctx, userId);
const prepareContext = (c: import('playwright-core').BrowserContext) => installDemoAts(c, store);
const actions = async (jobId: string, type: string) => t.ctx.db.select().from(actionItems).where(and(eq(actionItems.jobId, jobId), eq(actionItems.type, type), eq(actionItems.status, 'open')));
const autopilot = async (patch: Record<string, unknown>) => setSetting(t.ctx.db, userId, 'application.autopilot', { ...(await getSetting(t.ctx.db, userId, 'application.autopilot')), ...patch });

let n = 0;
const TREES = ['Alder', 'Birch', 'Cedar', 'Dogwood', 'Elm', 'Fir', 'Ginkgo', 'Hazel', 'Ironwood', 'Juniper', 'Kauri', 'Larch', 'Maple', 'Nutmeg', 'Oak', 'Pine', 'Quince', 'Rowan', 'Spruce', 'Teak', 'Ulmus', 'Viburnum', 'Willow', 'Yew', 'Zelkova', 'Acacia', 'Baobab', 'Cypress', 'Ebony', 'Fig'];
const TITLES = ['Senior Associate Transaction Services', 'Financial Due Diligence Manager', 'Deal Advisory Consultant', 'M&A Analyst', 'Valuation Associate', 'Corporate Finance Associate'];
/** Identifiant d'offre propre à chaque test (une même offre ATS serait reconnue comme doublon). */
function uniqueUrl(url: string, k: number): string {
  if (url === DEMO_URLS.gone || url === DEMO_URLS.down) return url;
  return url
    .replace(/\/jobs\/(4[12])(\d+)$/, (_m, p: string) => `/jobs/${p}${String(10000 + k)}`)
    .replace(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-)[0-9a-f]{12}/, (_m, p: string) => `${p}${k.toString(16).padStart(12, '0')}`)
    .replace(/_R\d+$/, `_R${1000 + k}`)
    .replace(/\/j\/[A-Z0-9]+\/$/, `/j/AB12${String(k).padStart(6, '0')}/`)
    .replace(/job=\d+$/, `job=${100 + k}`)
    .replace(/\/view\/(\d+)$/, (_m, d: string) => `/view/${d}${k}`);
}

/** Offre prête à envoyer : documents validés (CV de la candidature), étape « prête ». */
async function readyJob(base: string, extra: Partial<typeof jobs.$inferInsert> = {}) {
  n++;
  const url = uniqueUrl(base, n);
  const added = await api.post("/api/jobs", { title: `${TITLES[n % TITLES.length]} (${TREES[n % TREES.length]})`, company: `${TREES[n % TREES.length]} ${['Partners', 'Advisory', 'Capital', 'Conseil'][n % 4]} ${String.fromCharCode(65 + (n % 26))}${n}`, location: "Paris", url, text: `Financial due diligence for private equity funds, quality of earnings, net debt and working capital analysis. Reference DEMO-${n}.` });
  expect(added.status).toBe(201);
  const jobId = added.data.job.id as string;
  await t.ctx.db.update(jobs).set({ stage: 'ready_to_apply', atsScore: 16, priorityScore: 80, country: 'FR', ...extra }).where(eq(jobs.id, jobId));
  // CV de la candidature : version propre à l'offre, avec son PDF.
  const fileId = await saveFile(t.ctx.db, { userId, kind: 'cv_pdf', filename: `CV Camille Durand - ${n}.pdf`, mime: 'application/pdf', data: new Uint8Array(PDF) });
  const [master] = await t.ctx.db.select().from(cvVersions).where(eq(cvVersions.id, masterId));
  const cvId = newId('cv');
  await t.ctx.db.insert(cvVersions).values({ ...master!, id: cvId, kind: 'application', jobId, parentId: masterId, pdfFileId: fileId, docxFileId: null, status: 'approved', createdAt: new Date(), approvedAt: new Date() });
  await t.ctx.db.insert(applications).values({ id: newId('app'), userId, jobId, cvVersionId: cvId, mode: 'assisted', applyUrl: url, authorizedBy: 'user', authorizedAt: new Date(), preparedAt: new Date() });
  return { jobId, cvId, fileId, url };
}

beforeAll(async () => {
  t = await makeTestEnv();
  ({ api, userId } = await signedIn(t));
  const imported = await api.post('/api/profile/cv/import', (() => {
    const f = new FormData();
    f.set('file', new File([PDF], 'CV Camille.pdf', { type: 'application/pdf' }));
    return f;
  })());
  expect(imported.status).toBe(200);
  masterId = imported.data.cv.id;
  expect((await api.post(`/api/profile/cv/${masterId}/approve`)).status).toBe(200);
  const facts: [string, unknown][] = [
    ['contact.first_name', 'Camille'],
    ['contact.last_name', 'Durand'],
    ['contact.email', 'camille.durand@example.test'],
    ['contact.phone', '+33 6 12 34 56 78'],
    ['contact.city', 'Paris'],
    ['contact.country', 'France'],
    ['contact.linkedin_url', 'https://www.linkedin.com/in/camille-durand-demo'],
    ['eligibility.work_authorization', ['Union européenne']],
    ['eligibility.sponsorship_needed', ['États-Unis']],
    ['availability.notice_period', '3 mois'],
    ['background.current_employer', 'Cabinet Exemple'],
  ];
  for (const [key, value] of facts) await setFact(t.ctx.db, userId, { key, value, source: 'user' });
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await t.close();
});
beforeEach(async () => {
  store = { submissions: [], mode: {} };
  await autopilot({ enabled: true, platforms: { greenhouse: 'auto', lever: 'auto', ashby: 'auto', workable: 'auto', workday: 'auto' }, consents: { privacyPolicy: true, accuracyAttestation: false, declineDemographics: true }, maxPerDay: 50, maxPerWeek: 200 });
});

describe('candidature automatique (AUTOPILOT)', () => {
  it('Greenhouse : remplit depuis le profil, joint le CV de CETTE candidature, envoie et garde la confirmation', async () => {
    const { jobId } = await readyJob(DEMO_URLS.greenhouse);
    const r = await runAutomation(uctx(), jobId, { browser, prepareContext });
    expect(r.plan).toMatchObject({ platform: 'greenhouse', mode: 'auto', autopilot: true });
    expect(r.outcome.status).toBe('submitted');
    expect(store.submissions).toHaveLength(1);
    const sub = store.submissions[0]!;
    expect(sub.fields).toMatchObject({
      'job_application[first_name]': 'Camille',
      'job_application[last_name]': 'DURAND',
      'job_application[email]': 'camille.durand@example.test',
      'job_application[phone]': '+33 6 12 34 56 78',
      'job_application[answers_attributes][0][text_value]': 'https://www.linkedin.com/in/camille-durand-demo',
      // Droit au travail en France : oui (Union européenne) ; visa : non. Diversité : « ne souhaite pas répondre ».
      'job_application[answers_attributes][1][boolean_value]': '1',
      'job_application[answers_attributes][2][boolean_value]': '0',
      'job_application[gender]': '3',
      'job_application[data_compliance][gdpr_consent_given]': '1',
    });
    // Le document joint est bien le PDF de cette candidature, à l'octet près.
    expect(sub.files['job_application[resume]']).toMatchObject({ sha256: PDF_SHA });
    const [app] = await t.ctx.db.select().from(applications).where(eq(applications.jobId, jobId));
    expect(app!.submittedAt).not.toBeNull();
    expect((app!.confirmation as any)).toMatchObject({ source: 'page' });
    expect((app!.confirmation as any).text).toMatch(/Thank you for applying/);
    expect((await t.ctx.db.select().from(jobs).where(eq(jobs.id, jobId)))[0]!.stage).toBe('confirmed');
    const [attempt] = await t.ctx.db.select().from(applicationAttempts).where(eq(applicationAttempts.applicationId, app!.id));
    expect(attempt).toMatchObject({ status: 'submitted', platform: 'greenhouse', mode: 'auto' });
    expect((attempt!.stats as any).complete).toBe(true);
    expect(attempt!.screenshotFileIds.length).toBeGreaterThan(0);
    // Une seconde exécution ne renvoie jamais rien.
    const again = await runAutomation(uctx(), jobId, { browser, prepareContext });
    expect(again.outcome.status).toBe('already_submitted');
    expect(store.submissions).toHaveLength(1);
  }, 90_000);

  it('Lever : formulaire atteint depuis la page de l’offre, bouton radio, envoi confirmé', async () => {
    const { jobId } = await readyJob(DEMO_URLS.lever, { country: 'LU' });
    const r = await runAutomation(uctx(), jobId, { browser, prepareContext });
    expect(r.outcome.status).toBe('submitted');
    expect(store.submissions[0]!.fields).toMatchObject({ name: 'Camille DURAND', email: 'camille.durand@example.test', org: 'Cabinet Exemple', 'urls[LinkedIn]': 'https://www.linkedin.com/in/camille-durand-demo', 'cards[q1][field0]': 'Yes' });
    expect(store.submissions[0]!.files.resume?.sha256).toBe(PDF_SHA);
  }, 90_000);

  it('Ashby : liste déroulante personnalisée renseignée depuis le profil', async () => {
    const { jobId } = await readyJob(DEMO_URLS.ashby);
    const r = await runAutomation(uctx(), jobId, { browser, prepareContext });
    expect(r.outcome.status).toBe('submitted');
    expect(store.submissions[0]!.fields).toMatchObject({ _systemfield_name: 'Camille DURAND', location: 'Paris, France' });
  }, 90_000);

  it('Workday : parcours en plusieurs étapes rempli de bout en bout ; l’envoi reste à vous (politique de la plateforme)', async () => {
    const { jobId } = await readyJob(DEMO_URLS.workday);
    const r = await runAutomation(uctx(), jobId, { browser, prepareContext });
    expect(r.plan.mode).toBe('prefill');
    expect(r.outcome.status).toBe('ready_to_submit');
    expect(store.submissions).toHaveLength(0);
    const fields = (r.attempt!.fields as any[]).filter((f) => f.status === 'ready');
    // Trois étapes de champs remplies : identité, CV, questions (droit au travail, visa, préavis).
    expect(fields.map((f) => f.canonical)).toEqual(expect.arrayContaining(['identity.first_name', 'identity.last_name', 'contact.country', 'eligibility.work_authorization', 'eligibility.sponsorship', 'availability.notice_period']));
    const [handoff] = await actions(jobId, 'application.handoff');
    expect(handoff!.body).toMatchObject({ reason: 'ready', platform: 'workday' });
  }, 90_000);

  it('Workday (pilote seul, envoi autorisé) : étapes, validation, envoi et confirmation dans la même page', async () => {
    const files = new Map([['cv', { name: 'CV.pdf', mime: 'application/pdf', data: new Uint8Array(PDF) }]]);
    const job = { id: 'job_demo', companyName: 'Demo Advisory', country: 'FR', title: 'Senior Associate' };
    const ap = { enabled: true, platforms: {}, countries: [], contracts: [], titleKeywords: [], excludeKeywords: [], minAtsScore: 0, minPriority: 0, requireLetter: false, maxPerDay: 5, maxPerWeek: 20, allowDerivedAnswers: true, allowLetterAnswers: false, consents: { privacyPolicy: true, accuracyAttestation: false, declineDemographics: true } };
    const res = await runApplication({
      url: DEMO_URLS.workday,
      mode: 'auto',
      browser,
      prepareContext,
      files,
      allowPlatform: () => true,
      beforeSubmit: async () => true,
      resolve: (fields) => resolveFields(uctx(), fields, { job, cv: null, docs: { resume: { fileId: 'cv', filename: 'CV.pdf' }, coverLetter: null, letterText: '' }, autopilot: ap, sourceLabel: '' }),
    });
    if (res.outcome.status !== 'submitted') console.log('WORKDAY-DEBUG', JSON.stringify(res.outcome), JSON.stringify(res.steps.map((s) => `${s.kind}:${s.detail}`)), JSON.stringify(res.pages.map((p) => p.fields.map((f) => `${f.label}=${f.status}:${String(f.value).slice(0, 20)}`))));
    expect(res.outcome.status).toBe('submitted');
    expect(res.pages.length).toBeGreaterThanOrEqual(3);
    expect(store.submissions[0]!.fields).toMatchObject({ fn: 'Camille', ln: 'DURAND', ctry: 'FR', auth: 'yes', visa: 'no', notice: '3 mois' });
    expect(store.submissions[0]!.files.cv?.sha256).toBe(PDF_SHA);
  }, 90_000);

  it('mode VALIDATION : tout est rempli, rien n’est envoyé ; la candidature attend votre envoi', async () => {
    await autopilot({ enabled: false });
    const { jobId } = await readyJob(DEMO_URLS.greenhouse);
    const r = await runAutomation(uctx(), jobId, { browser, prepareContext });
    expect(r.plan.mode).toBe('prefill');
    expect(r.outcome.status).toBe('ready_to_submit');
    expect(store.submissions).toHaveLength(0);
    expect((r.attempt!.stats as any).complete).toBe(true);
  }, 90_000);
});

describe('questions et interventions', () => {
  it('question inconnue : posée une seule fois, puis réutilisée — rien n’est à ressaisir', async () => {
    const first = await readyJob(DEMO_URLS.greenhouseCustom);
    const r1 = await runAutomation(uctx(), first.jobId, { browser, prepareContext });
    expect(r1.outcome.status).toBe('needs_answers');
    const [todo] = await actions(first.jobId, 'application.questions');
    // Une seule question posée : tout le reste vient du profil.
    expect((todo!.body as any).questions.map((q: any) => q.label)).toEqual(['Have you passed CFA Level I?']);
    expect((todo!.body as any).questions[0].options.map((o: any) => o.label)).toEqual(['Please select', 'Yes', 'No']);
    const res = await answerQuestions(uctx(), first.jobId, [{ label: 'Have you passed CFA Level I?', answer: 'No', scope: 'general' }]);
    expect(res).toMatchObject({ saved: 1, relaunched: true });
    const r2 = await runAutomation(uctx(), first.jobId, { browser, prepareContext });
    expect(r2.outcome.status).toBe('submitted');
    expect(store.submissions[0]!.fields['job_application[answers_attributes][4][boolean_value]']).toBe('0');
    // Autre offre, même question : réponse réutilisée, aucune question.
    const second = await readyJob(DEMO_URLS.greenhouseCustom);
    const r3 = await runAutomation(uctx(), second.jobId, { browser, prepareContext });
    expect(r3.outcome.status).toBe('submitted');
    expect(await actions(second.jobId, 'application.questions')).toHaveLength(0);
  }, 120_000);

  it('déclaration non autorisée : arrêt avant l’envoi, avec la raison', async () => {
    await autopilot({ consents: { privacyPolicy: false, accuracyAttestation: false, declineDemographics: true } });
    const { jobId } = await readyJob(DEMO_URLS.greenhouse);
    const r = await runAutomation(uctx(), jobId, { browser, prepareContext });
    expect(r.outcome).toMatchObject({ status: 'needs_human', reason: 'legal' });
    expect(store.submissions).toHaveLength(0);
  }, 90_000);

  it('CAPTCHA : jamais contourné ; tout le reste est conservé pour la reprise', async () => {
    store.mode.captcha = true;
    const { jobId } = await readyJob(DEMO_URLS.lever, { country: 'LU' });
    const r = await runAutomation(uctx(), jobId, { browser, prepareContext });
    expect(r.outcome).toMatchObject({ status: 'needs_human', reason: 'captcha' });
    expect(store.submissions).toHaveLength(0);
    const ready = (r.attempt!.fields as any[]).filter((f) => f.status === 'ready');
    expect(ready.length).toBeGreaterThanOrEqual(6);
    const [handoff] = await actions(jobId, 'application.handoff');
    expect((handoff!.body as any).reason).toBe('captcha');
    expect((handoff!.body as any).text).toContain('extension');
  }, 90_000);

  it('connexion au compte candidat : demandée à vous, aucun identifiant demandé ni stocké', async () => {
    const { jobId } = await readyJob(DEMO_URLS.login);
    const r = await runAutomation(uctx(), jobId, { browser, prepareContext });
    expect(r.plan.platform).toBe('taleo');
    expect(r.outcome).toMatchObject({ status: 'needs_human', reason: 'login' });
    expect((r.outcome as any).detail).toContain('Vos identifiants ne sont jamais demandés');
  }, 90_000);

  it('LinkedIn, Indeed, WTTJ : aucune automatisation ; préparation et preuve de la restriction', async () => {
    for (const url of ['https://www.linkedin.com/jobs/view/4100000001', 'https://fr.indeed.com/viewjob?jk=abc123', 'https://www.welcometothejungle.com/fr/companies/demo/jobs/senior-associate']) {
      const { jobId } = await readyJob(url);
      const r = await runAutomation(uctx(), jobId, { browser, prepareContext });
      expect(r.plan.mode).toBe('manual');
      expect(r.outcome.status).toBe('manual');
      const [todo] = await actions(jobId, 'application.manual');
      expect((todo!.body as any).evidence[0].url).toMatch(/linkedin\.com\/legal|indeed\.com\/legal|welcometothejungle\.com/);
    }
  }, 90_000);
});

describe('résilience et anti-doublon', () => {
  it('page refusant l’envoi : rien n’est parti, la raison est donnée', async () => {
    store.mode.rejectEmail = true;
    const { jobId } = await readyJob(DEMO_URLS.greenhouse);
    const r = await runAutomation(uctx(), jobId, { browser, prepareContext });
    expect(r.outcome).toMatchObject({ status: 'needs_human', reason: 'validation' });
    expect((r.outcome as any).detail).toContain('Email is invalid');
    expect(store.submissions).toHaveLength(0);
  }, 90_000);

  it('pas de confirmation lisible : envoi « incertain », jamais renvoyé sans votre vérification', async () => {
    const { jobId } = await readyJob(DEMO_URLS.workable);
    const r = await runAutomation(uctx(), jobId, { browser, prepareContext });
    expect(r.outcome.status).toBe('uncertain');
    expect(store.submissions).toHaveLength(1);
    expect((await t.ctx.db.select().from(jobs).where(eq(jobs.id, jobId)))[0]!.stage).toBe('applying');
    expect(await actions(jobId, 'application.verify')).toHaveLength(1);
    const again = await runAutomation(uctx(), jobId, { browser, prepareContext });
    expect(again.outcome.status).toBe('uncertain');
    expect(store.submissions).toHaveLength(1);
  }, 90_000);

  it('interruption pendant l’envoi : aucune seconde candidature', async () => {
    const { jobId } = await readyJob(DEMO_URLS.greenhouse);
    const [app] = await t.ctx.db.select().from(applications).where(eq(applications.jobId, jobId));
    await t.ctx.db.insert(applicationAttempts).values({ id: newId('att'), userId, applicationId: app!.id, status: 'submitting', platform: 'greenhouse', mode: 'auto' });
    const r = await runAutomation(uctx(), jobId, { browser, prepareContext });
    expect(r.outcome.status).toBe('uncertain');
    expect(store.submissions).toHaveLength(0);
  }, 60_000);

  it('deux exécutions simultanées : une seule candidature part', async () => {
    const { jobId } = await readyJob(DEMO_URLS.greenhouse);
    const [a, b] = await Promise.all([runAutomation(uctx(), jobId, { browser, prepareContext }), runAutomation(uctx(), jobId, { browser, prepareContext })]);
    expect([a.outcome.status, b.outcome.status].filter((s) => s === 'submitted')).toHaveLength(1);
    expect(store.submissions).toHaveLength(1);
  }, 120_000);

  it('site en panne : échec technique sans envoi, puis reprise normale', async () => {
    store.mode.failNext = 1;
    const { jobId } = await readyJob(DEMO_URLS.greenhouse);
    await expect(runAutomation(uctx(), jobId, { browser, prepareContext })).rejects.toThrow(/ne répond pas/);
    const r = await runAutomation(uctx(), jobId, { browser, prepareContext });
    expect(r.outcome.status).toBe('submitted');
    expect(store.submissions).toHaveLength(1);
  }, 120_000);

  it('offre retirée (404) : signalée, rien n’est tenté', async () => {
    const { jobId } = await readyJob(DEMO_URLS.gone);
    const r = await runAutomation(uctx(), jobId, { browser, prepareContext });
    expect(r.outcome).toMatchObject({ status: 'needs_human', reason: 'unknown_form' });
    expect((r.outcome as any).detail).toContain('retirée');
  }, 60_000);
});

describe('règles, sécurité et indicateurs', () => {
  it('les règles AUTOPILOT et la politique de la plateforme fixent le mode', async () => {
    await autopilot({ countries: ['LU'] });
    const { jobId } = await readyJob(DEMO_URLS.greenhouse);
    const plan = await planAutomation(uctx(), jobId);
    expect(plan.mode).toBe('prefill');
    expect(plan.checks.find((c) => c.id === 'country')).toMatchObject({ ok: false });
    // Annonce piégée : jamais d'envoi automatique.
    await autopilot({ countries: [] });
    await t.ctx.db.update(jobs).set({ flags: { injection: [{ id: 'ignore_instructions', excerpt: 'ignore previous instructions' }] } }).where(eq(jobs.id, jobId));
    expect((await planAutomation(uctx(), jobId)).mode).toBe('prefill');
    // Plateforme interdite : même autorisée par l'utilisateur, aucune automatisation.
    await autopilot({ platforms: { linkedin: 'auto' } });
    const li = await readyJob('https://www.linkedin.com/jobs/view/4100000002');
    expect((await planAutomation(uctx(), li.jobId)).mode).toBe('manual');
    expect(detectPlatform('https://demo.wd3.myworkdayjobs.com/x')).toBe('workday');
    expect(detectPlatform('https://careers.example.com/job?gh_jid=123')).toBe('greenhouse');
  });

  it('un CV d’une autre offre n’est jamais joint', async () => {
    const a = await readyJob(DEMO_URLS.greenhouse);
    const b = await readyJob(DEMO_URLS.greenhouse);
    await t.ctx.db.update(applications).set({ cvVersionId: b.cvId }).where(eq(applications.jobId, a.jobId));
    await expect(runAutomation(uctx(), a.jobId, { browser, prepareContext })).rejects.toThrow(/autre offre/);
    expect(store.submissions).toHaveLength(0);
  }, 60_000);

  it('extension : réponses calculées par JobAgent, refus sur les plateformes interdites', async () => {
    const { token } = await createApiToken(t.ctx.db, userId, 'extension', ['apply']);
    const { jobId, url } = await readyJob(DEMO_URLS.greenhouse);
    const call = (path: string, payload: unknown) => t.app.request(`/api/apply/extension/${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const lookup = await (await call('lookup', { url })).json();
    expect(lookup).toMatchObject({ platform: 'greenhouse', match: { jobId } });
    const field = { key: 'f1', tag: 'input', type: 'text', label: 'First Name', name: 'first_name', id: 'first_name', required: true, options: [], multiple: false, accept: '', value: '', placeholder: '', autocomplete: '', section: '' };
    const resolved = await (await call('resolve', { url, jobId, fields: [field] })).json();
    expect(resolved.fields[0]).toMatchObject({ value: 'Camille', source: 'profile', status: 'ready' });
    const refused = await (await call('resolve', { url: 'https://www.linkedin.com/jobs/view/1', jobId, fields: [field] })).json();
    expect(refused.refused).toBe(true);
    // Sans le bon jeton, rien n'est accessible.
    const anon = await t.app.request('/api/apply/extension/lookup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: DEMO_URLS.greenhouse }) });
    expect([401, 403]).toContain(anon.status);
  });

  it('indicateurs : taux de remplissage, envois sans intervention, motifs d’arrêt', async () => {
    const m = await automationMetrics(uctx());
    expect(m.attempts).toBeGreaterThan(5);
    expect(m.averageAutoFillRate).toBeGreaterThan(50);
    expect(m.submittedApplications).toBeGreaterThan(3);
    expect(m.shareWithoutIntervention).toBeGreaterThan(0);
    expect(Object.keys(m.interventionReasons)).toEqual(expect.arrayContaining(['captcha', 'login', 'legal', 'platform']));
    expect(m.uncertain).toBeGreaterThanOrEqual(1);
  });
});
