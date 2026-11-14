// Extension de navigateur : son script de page (extension/content.js) est exécuté tel quel
// dans un formulaire de DÉMONSTRATION ; le service d'arrière-plan est remplacé par un pont
// qui appelle l'API JobAgent avec un jeton « apply », exactement comme background.js.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { chromium, type Browser } from 'playwright-core';
import { makeTestEnv, signedIn, type TestEnv } from '../helpers.js';
import { DEMO_URLS, installDemoAts, type DemoStore } from '../fixtures/ats-demo.js';
import { saveFile } from '../../src/core/files.js';
import { newId } from '../../src/db/ids.js';
import { applications, cvVersions, jobs } from '../../src/db/schema.js';
import { setFact } from '../../src/profile/facts.js';
import { createApiToken } from '../../src/auth/service.js';

const PDF = readFileSync('tests/fixtures/cv/camille-durand.pdf');
const INPAGE = readFileSync('src/apply/engine/inpage.js', 'utf8');
const CONTENT = readFileSync('extension/content.js', 'utf8');

let t: TestEnv;
let browser: Browser;
let token = '';
let jobId = '';
let userId = '';
const url = DEMO_URLS.greenhouse.replace('4100001', '4100777');

/** Ce que fait background.js : appels à l'API avec le jeton, documents renvoyés en base64. */
async function bridge(msg: { type: string; url?: string; jobId?: string; fields?: unknown; fileId?: string; text?: string }) {
  const call = async (path: string, body?: unknown) => {
    const res = await t.app.request(`/api${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (path.startsWith('/apply/extension/file/')) {
      if (!res.ok) return { error: `http_${res.status}` };
      return { name: decodeURIComponent(res.headers.get('x-filename') ?? 'doc.pdf'), mime: res.headers.get('content-type'), base64: Buffer.from(await res.arrayBuffer()).toString('base64') };
    }
    const data = await res.json();
    return res.ok ? data : { error: data?.error?.message ?? `http_${res.status}` };
  };
  if (msg.type === 'lookup') return call('/apply/extension/lookup', { url: msg.url });
  if (msg.type === 'resolve') return call('/apply/extension/resolve', { url: msg.url, jobId: msg.jobId, fields: msg.fields });
  if (msg.type === 'file') return call(`/apply/extension/file/${msg.jobId}/${msg.fileId}`);
  if (msg.type === 'confirm') return call('/apply/extension/confirm', { jobId: msg.jobId, url: msg.url, text: msg.text });
  return { error: 'unknown' };
}

beforeAll(async () => {
  t = await makeTestEnv();
  const s = await signedIn(t);
  userId = s.userId;
  const f = new FormData();
  f.set('file', new File([PDF], 'CV Camille.pdf', { type: 'application/pdf' }));
  const imported = await s.api.post('/api/profile/cv/import', f);
  const masterId = imported.data.cv.id;
  await s.api.post(`/api/profile/cv/${masterId}/approve`);
  for (const [key, value] of [['contact.first_name', 'Camille'], ['contact.last_name', 'Durand'], ['contact.email', 'camille.durand@example.test'], ['contact.phone', '+33 6 12 34 56 78'], ['eligibility.work_authorization', ['France']]] as [string, unknown][]) await setFact(t.ctx.db, userId, { key, value, source: 'user' });
  const added = await s.api.post('/api/jobs', { title: 'Senior Associate Transaction Services', company: 'Extension Demo Advisory', location: 'Paris', url, text: 'Financial due diligence for private equity funds, quality of earnings and net debt analysis, Paris office.' });
  jobId = added.data.job.id;
  await t.ctx.db.update(jobs).set({ stage: 'ready_to_apply', country: 'FR' }).where(eq(jobs.id, jobId));
  const fileId = await saveFile(t.ctx.db, { userId, kind: 'cv_pdf', filename: 'CV Camille Durand.pdf', mime: 'application/pdf', data: new Uint8Array(PDF) });
  const [master] = await t.ctx.db.select().from(cvVersions).where(eq(cvVersions.id, masterId));
  const cvId = newId('cv');
  await t.ctx.db.insert(cvVersions).values({ ...master!, id: cvId, kind: 'application', jobId, parentId: masterId, pdfFileId: fileId, docxFileId: null, status: 'approved', createdAt: new Date(), approvedAt: new Date() });
  await t.ctx.db.insert(applications).values({ id: newId('app'), userId, jobId, cvVersionId: cvId, mode: 'assisted', applyUrl: url, authorizedBy: 'user', authorizedAt: new Date() });
  token = (await createApiToken(t.ctx.db, userId, 'extension', ['apply'])).token;
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await t.close();
});

describe('extension de navigateur', () => {
  it('remplit le formulaire et joint le CV, laisse l’envoi à l’utilisateur, puis enregistre la confirmation', async () => {
    const store: DemoStore = { submissions: [], mode: {} };
    const context = await browser.newContext();
    await installDemoAts(context, store);
    await context.exposeBinding('__jobagentBridge', (_src, msg) => bridge(msg));
    await context.addInitScript(() => {
      (window as any).chrome = { runtime: { sendMessage: (msg: unknown, cb: (r: unknown) => void) => (window as any).__jobagentBridge(msg).then(cb) } };
    });
    const page = await context.newPage();
    const inject = async () => {
      await page.evaluate(INPAGE);
      await page.evaluate(CONTENT);
    };
    await page.goto(url);
    await inject();
    await page.waitForFunction(() => document.getElementById('jobagent-panel')?.textContent?.includes('rempli'), null, { timeout: 15_000 });
    expect(await page.inputValue('#first_name')).toBe('Camille');
    expect(await page.inputValue('#email')).toBe('camille.durand@example.test');
    expect(await page.inputValue('#q_auth')).toBe('1');
    expect(await page.evaluate(() => (document.getElementById('resume') as HTMLInputElement).files?.[0]?.name)).toBe('CV Camille Durand.pdf');
    // La case de confidentialité n'est pas autorisée dans les règles : elle reste à l'utilisateur, et c'est dit.
    const panel = await page.textContent('#jobagent-panel');
    expect(panel).toContain('à compléter');
    expect(panel).toContain('privacy policy');
    expect(await page.isChecked('#gdpr')).toBe(false);
    // Rien n'est envoyé par l'extension.
    expect(store.submissions).toHaveLength(0);
    // L'utilisateur coche, envoie ; la page de confirmation (nouvelle page) est rattachée à la candidature.
    await page.check('#gdpr');
    await page.click('#submit_app');
    await page.waitForLoadState('domcontentloaded');
    await inject();
    await page.waitForFunction(() => document.getElementById('jobagent-panel')?.textContent?.includes('confirmation enregistrée'), null, { timeout: 15_000 });
    expect(store.submissions).toHaveLength(1);
    expect(store.submissions[0]!.files['job_application[resume]']?.name).toBe('CV Camille Durand.pdf');
    const [job] = await t.ctx.db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(job!.stage).toBe('confirmed');
    const [app] = await t.ctx.db.select().from(applications).where(eq(applications.jobId, jobId));
    expect((app!.confirmation as any).text).toContain('thank you for applying');
    await context.close();
  }, 90_000);

  it('n’agit pas sur une plateforme dont les conditions l’interdisent', async () => {
    const res = await bridge({ type: 'lookup', url: 'https://www.linkedin.com/jobs/view/123' });
    expect(res.policy.autonomy).toBe('manual');
    const fields = await bridge({ type: 'resolve', url: 'https://www.linkedin.com/jobs/view/123', jobId, fields: [] });
    expect(fields.refused).toBe(true);
  });

  it('un jeton « apply » ne lit ni le profil, ni les documents, ni les offres', async () => {
    for (const path of ['/api/profile/summary', '/api/jobs', '/api/files/x', '/api/settings', '/api/applications']) {
      const res = await t.app.request(path, { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(403);
    }
    // Un document qui n'appartient pas à la candidature est refusé.
    const other = await saveFile(t.ctx.db, { userId, kind: 'other', filename: 'autre.pdf', mime: 'application/pdf', data: new Uint8Array([1, 2, 3]) });
    const res = await t.app.request(`/api/apply/extension/file/${jobId}/${other}`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(409); // candidature déjà envoyée : plus aucun document servi
  });
});
