// Chaîne complète, sans attente entre les étapes : offre → qualification → analyse ATS
// (prompt de l'utilisateur) → CV et lettre dans les modèles → contrôles → validation
// AUTOPILOT → remplissage du formulaire → pièces jointes → envoi → confirmation → suivi
// e-mail → entretien → préparation. Formulaire de DÉMONSTRATION (aucun recruteur réel).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { chromium, type Browser } from 'playwright-core';
import { makeTestEnv, signedIn, type FetchMock, type TestEnv } from '../helpers.js';
import { letterTemplateDocx } from '../fixtures/letter-template.js';
import { DEMO_URLS, installDemoAts, type DemoStore } from '../fixtures/ats-demo.js';
import { forUser } from '../../src/core/context.js';
import { getFile } from '../../src/core/files.js';
import { getSetting, setSetting } from '../../src/core/settings.js';
import { newId } from '../../src/db/ids.js';
import { actionItems, applicationAttempts, applications, cvVersions, emails, interviews, jobs } from '../../src/db/schema.js';
import { automationHooks } from '../../src/apply/automation.js';
import { runWorker } from '../../src/pipeline/worker.js';
import { setFact } from '../../src/profile/facts.js';
import { applyMailEffects } from '../../src/tracker/mail.js';

const FIXTURE = 'tests/fixtures/cv/camille-durand.pdf';
const OFFER = `Senior Associate Transaction Services (H/F) — Paris.
Missions : due diligence financière côté acquéreur et côté vendeur, analyse de la qualité des résultats (EBITDA normatif), de la dette nette et du BFR, rédaction des rapports pour des fonds d'investissement.
Profil : audit ou transaction services, normes IFRS, modélisation financière, anglais courant. Poste en CDI à Paris.`;

let t: TestEnv;
let api: Awaited<ReturnType<typeof signedIn>>['api'];
let userId: string;
let browser: Browser;
let store: DemoStore;
const uctx = () => forUser(t.ctx, userId);
const work = async () => {
  for (let i = 0; i < 20; i++) {
    const r = await runWorker(t.ctx, { budgetMs: 120_000, workerId: 'test' });
    if (!r.processed) break;
  }
};
const jobRow = async (id: string) => (await t.ctx.db.select().from(jobs).where(eq(jobs.id, id)))[0]!;
const openActions = async (jobId: string) => (await t.ctx.db.select().from(actionItems).where(and(eq(actionItems.jobId, jobId), eq(actionItems.status, 'open')))).map((a) => a.type);
const autopilot = async (patch: Record<string, unknown>) => setSetting(t.ctx.db, userId, 'application.autopilot', { ...(await getSetting(t.ctx.db, userId, 'application.autopilot')), ...patch });
const form = (data: Uint8Array | Buffer, name: string, type: string) => {
  const f = new FormData();
  f.set('file', new File([data], name, { type }));
  return f;
};

// Pages d'offres : ouvertes, sauf l'offre retirée (vérifiée avant toute préparation).
const net: FetchMock = (url) => {
  if (url.includes('/jobs/4109999')) return new Response('<html><body><h1>This job is no longer available</h1></body></html>', { status: 404, headers: { 'content-type': 'text/html' } });
  if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /', { status: 200 });
  return new Response(`<html><head><title>Senior Associate</title></head><body><h1>Senior Associate Transaction Services</h1><p>${OFFER}</p></body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
};

beforeAll(async () => {
  t = await makeTestEnv({ fetch: net });
  ({ api, userId } = await signedIn(t));
  const imported = await api.post('/api/profile/cv/import', form(readFileSync(FIXTURE), 'CV Camille.pdf', 'application/pdf'));
  await api.post(`/api/profile/cv/${imported.data.cv.id}/approve`);
  expect((await api.post('/api/documents/templates/letter', form(await letterTemplateDocx(), 'modele-lettre.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'))).status).toBe(200);
  await api.post('/api/profile/ats-prompt', { content: 'Tu es expert ATS. Évalue le CV : tableau noté sur 5, somme ajustée sur 20.\n■ CV : Copier/coller\n■ Offre d’emploi : Copier/coller' });
  for (const [key, value] of [['contact.first_name', 'Camille'], ['contact.last_name', 'Durand'], ['contact.email', 'camille.durand@example.test'], ['contact.phone', '+33 6 12 34 56 78'], ['eligibility.work_authorization', ['France']], ['eligibility.sponsorship_needed', ['États-Unis']]] as [string, unknown][]) await setFact(t.ctx.db, userId, { key, value, source: 'user' });
  browser = await chromium.launch();
  automationHooks.browser = browser;
  automationHooks.prepareContext = (c) => installDemoAts(c, store);
}, 120_000);
afterAll(async () => {
  automationHooks.browser = undefined;
  automationHooks.prepareContext = undefined;
  await browser?.close();
  await t.close();
});
beforeEach(() => {
  store = { submissions: [], mode: {} };
});

describe('chaîne complète AUTOPILOT', () => {
  it('de l’offre à la candidature envoyée et confirmée, sans aucune intervention', async () => {
    await autopilot({ enabled: true, minAtsScore: 0, minPriority: 0, platforms: { greenhouse: 'auto' }, consents: { privacyPolicy: true, accuracyAttestation: false, declineDemographics: true } });
    await setSetting(t.ctx.db, userId, 'application.autonomous', { ...(await getSetting(t.ctx.db, userId, 'application.autonomous')), autoApproveDocuments: true });
    const url = DEMO_URLS.greenhouse.replace('4100001', '4100501');
    const added = await api.post('/api/jobs', { url, title: 'Senior Associate Transaction Services', company: 'Ashwood Advisory', location: 'Paris', text: OFFER });
    expect(added.status).toBe(201);
    const jobId = added.data.job.id as string;
    await work();
    const job = await jobRow(jobId);
    expect(job.stage).toBe('confirmed');
    expect(job.atsScore).not.toBeNull();
    // Le CV joint est le CV personnalisé de CETTE offre, produit par la chaîne.
    const [app] = await t.ctx.db.select().from(applications).where(eq(applications.jobId, jobId));
    expect(app).toMatchObject({ authorizedBy: 'autopilot', mode: 'auto' });
    expect((app!.confirmation as any).source).toBe('page');
    const [cv] = await t.ctx.db.select().from(cvVersions).where(eq(cvVersions.id, app!.cvVersionId!));
    expect(cv!.jobId).toBe(jobId);
    const pdf = await getFile(t.ctx.db, userId, cv!.pdfFileId!);
    expect(store.submissions).toHaveLength(1);
    expect(store.submissions[0]!.files['job_application[resume]']?.sha256).toBe(createHash('sha256').update(pdf!.data).digest('hex'));
    expect(store.submissions[0]!.files['job_application[cover_letter]']).toBeTruthy();
    const [attempt] = await t.ctx.db.select().from(applicationAttempts).where(eq(applicationAttempts.applicationId, app!.id));
    expect(attempt).toMatchObject({ status: 'submitted', mode: 'auto', trigger: 'autopilot' });
    // Aucune demande en attente pour cette offre : tout s'est enchaîné.
    expect(await openActions(jobId)).toEqual([]);
  }, 300_000);

  it('mode VALIDATION : les documents vous sont présentés, rien ne part', async () => {
    await autopilot({ enabled: false });
    const url = DEMO_URLS.greenhouse.replace('4100001', '4100502');
    const added = await api.post('/api/jobs', { url, title: 'Financial Due Diligence Manager', company: 'Birchfield Partners', location: 'Paris', text: OFFER });
    const jobId = added.data.job.id as string;
    await work();
    // L'offre est analysée et vous est présentée ; rien n'est préparé ni envoyé sans votre décision.
    expect(['awaiting_feedback', 'analyzed']).toContain((await jobRow(jobId)).stage);
    expect(await openActions(jobId)).toContain('job.review');
    expect(store.submissions).toHaveLength(0);
  }, 300_000);

  it('offre retirée : vérifiée avant toute préparation, aucun document produit', async () => {
    await autopilot({ enabled: true, minAtsScore: 0, minPriority: 0 });
    const url = DEMO_URLS.greenhouse.replace('4100001', '4109999');
    const added = await api.post('/api/jobs', { url, title: 'Valuation Associate', company: 'Corbel Capital', location: 'Paris', text: OFFER });
    const jobId = added.data.job.id as string;
    await work();
    expect((await jobRow(jobId)).stage).toBe('expired');
    expect(await t.ctx.db.select().from(cvVersions).where(eq(cvVersions.jobId, jobId))).toHaveLength(0);
    expect(store.submissions).toHaveLength(0);
  }, 300_000);
});

describe('suivi après envoi', () => {
  it('un accusé de réception confirme un envoi incertain ; plus rien n’est demandé', async () => {
    const added = await api.post('/api/jobs', { title: 'M&A Analyst', company: 'Dunmore Corporate Finance', location: 'Paris', text: OFFER });
    const jobId = added.data.job.id as string;
    const appId = newId('app');
    await t.ctx.db.update(jobs).set({ stage: 'applying' }).where(eq(jobs.id, jobId));
    await t.ctx.db.insert(applications).values({ id: appId, userId, jobId, mode: 'auto', applyUrl: 'https://apply.workable.com/dunmore/j/X1/' });
    await t.ctx.db.insert(applicationAttempts).values({ id: newId('att'), userId, applicationId: appId, status: 'uncertain', platform: 'workable', mode: 'auto' });
    await t.ctx.db.insert(actionItems).values({ id: newId('todo'), userId, type: 'application.verify', title: 'Vérifier', jobId, dedupKey: `application.verify:${jobId}` });
    const [mail] = await t.ctx.db.insert(emails).values({ id: newId('eml'), userId, messageId: 'm1', threadKey: 't1', fromAddr: 'no-reply@workablemail.com', fromName: 'Dunmore', subject: 'Thanks for applying', snippet: 'Thank you for applying to Dunmore Corporate Finance. We have received your application.', date: new Date(), category: 'confirmation' }).returning();
    await applyMailEffects(uctx(), mail!, { jobId, applicationId: appId, companyName: 'Dunmore Corporate Finance', title: 'M&A Analyst', stage: 'applying' } as never, 'confirmation', { summary: '', proposedDate: '' });
    expect((await jobRow(jobId)).stage).toBe('confirmed');
    const [attempt] = await t.ctx.db.select().from(applicationAttempts).where(eq(applicationAttempts.applicationId, appId));
    expect(attempt!.status).toBe('submitted');
    expect(await openActions(jobId)).not.toContain('application.verify');
  });

  it('entretien déclaré : préparation générée aussitôt, sans rien inventer', async () => {
    const [job] = await t.ctx.db.select().from(jobs).where(and(eq(jobs.userId, userId), eq(jobs.stage, 'confirmed')));
    const res = await api.post(`/api/jobs/${job!.id}/stage`, { to: 'interview_hr' });
    expect(res.status).toBe(200);
    await work();
    const [itv] = await t.ctx.db.select().from(interviews).where(eq(interviews.jobId, job!.id));
    expect(itv!.prepStatus).toBe('ready');
    const prep = itv!.prep as any;
    expect(prep.likelyQuestions.length).toBeGreaterThan(0);
    // L'exemple inventé (entreprise absente du CV, chiffre inventé) a été écarté.
    expect(prep.stories.map((s: any) => s.title)).not.toContain('Histoire inventée');
    expect(prep.removed.join(' ')).toContain('Histoire inventée');
    expect(await openActions(job!.id)).toContain('interview.prep_ready');
    const detail = await api.get(`/api/jobs/${job!.id}`);
    expect(detail.data.interviews[0].prep.summary).toBeTruthy();
  }, 120_000);
});
