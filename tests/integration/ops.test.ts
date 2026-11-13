import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { TEST_PASSWORD, makeTestEnv, signedIn, type FetchMock, type TestEnv } from '../helpers.js';
import { forUser } from '../../src/core/context.js';
import { exportUserData } from '../../src/core/export.js';
import { raiseAction } from '../../src/core/inbox.js';
import { setSecret } from '../../src/core/secrets.js';
import { setSetting } from '../../src/core/settings.js';
import { cvVersions, jobs, notifications, tasks } from '../../src/db/schema.js';
import { buildDigest, localClock, notifyUrgent } from '../../src/notify/index.js';
import { schedulerTick } from '../../src/pipeline/scheduler.js';
import { ingestJob, manualSource } from '../../src/search/ingest.js';

const sent: { url: string; body: any; headers: Record<string, string> }[] = [];
const net: FetchMock = (url, init) => {
  sent.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null, headers: (init?.headers ?? {}) as Record<string, string> });
  return new Response('{}', { status: url.includes('en-panne') ? 500 : 200 });
};

let t: TestEnv;
let api: Awaited<ReturnType<typeof signedIn>>['api'];
let userId: string;
const uctx = () => forUser(t.ctx, userId);

beforeAll(async () => {
  t = await makeTestEnv({ fetch: net });
  ({ api, userId } = await signedIn(t));
  const form = new FormData();
  form.set('file', new File([readFileSync('tests/fixtures/cv/camille-durand.pdf')], 'CV.pdf', { type: 'application/pdf' }));
  const cv = await api.post('/api/profile/cv/import', form);
  await api.post(`/api/profile/cv/${cv.data.cv.id}/approve`);
  const source = await manualSource(uctx());
  for (const [company, title] of [['Northwind Capital', 'Senior Analyst'], ['Valmont Advisory', 'Analyste M&A']] as const) {
    const res = await ingestJob(uctx(), { company, title, location: 'Paris', descriptionText: `${title} — ${'analyse financière et due diligence pour des fonds. '.repeat(6)}` }, { source });
    if (company === 'Northwind Capital') await api.post(`/api/applications/${res.job.id}/submitted`, { channel: 'Email' });
  }
}, 120_000);
afterAll(() => t.close());

describe('notifications', () => {
  it('prévient une seule fois, sur les seuls canaux actifs, des événements choisis', async () => {
    await raiseAction(t.ctx.db, { userId, type: 'interview.detected', title: 'Entretien proposé : Northwind Capital — Senior Analyst', body: { text: 'Julie Morel propose un entretien.' }, dedupKey: 'interview:test-1', priority: 96 });
    await raiseAction(t.ctx.db, { userId, type: 'system.alert', title: 'Source en panne : Exemple', body: { text: 'Accès refusé.' }, dedupKey: 'source.down:test', priority: 78 });
    expect(await notifyUrgent(uctx())).toBe(0); // aucun canal activé : rien ne part
    await setSetting(t.ctx.db, userId, 'notifications.channels', { email: { enabled: false, to: '' }, telegram: { enabled: false, chatId: '' }, ntfy: { enabled: true, server: 'https://ntfy.example', topic: 'jobagent-secret-topic' }, webhook: { enabled: true, url: 'https://hooks.example/jobagent' } });
    await setSecret(t.ctx.db, t.ctx.env.appSecret, userId, 'webhook_secret', 'signature-secrete');
    await setSetting(t.ctx.db, userId, 'notifications.immediate', ['interview']);
    sent.length = 0;
    expect(await notifyUrgent(uctx())).toBe(2);
    expect(sent.map((s) => new URL(s.url).host).sort()).toEqual(['hooks.example', 'ntfy.example']);
    const ntfy = sent.find((s) => s.url.includes('ntfy'))!;
    expect(ntfy.body).toMatchObject({ topic: 'jobagent-secret-topic', title: 'Entretien proposé : Northwind Capital — Senior Analyst' });
    expect(sent.find((s) => s.url.includes('hooks'))!.headers['x-jobagent-signature']).toBeTruthy();
    // La panne de source n'est pas dans les événements choisis ; l'entretien n'est pas renvoyé.
    sent.length = 0;
    expect(await notifyUrgent(uctx())).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('refuse d’envoyer vers une adresse interne et consigne les échecs', async () => {
    await setSetting(t.ctx.db, userId, 'notifications.channels', { email: { enabled: false, to: '' }, telegram: { enabled: false, chatId: '' }, ntfy: { enabled: false, server: 'https://ntfy.sh', topic: '' }, webhook: { enabled: true, url: 'http://127.0.0.1:4000/api/settings' } });
    sent.length = 0;
    const res = await api.post('/api/settings/notifications/test');
    expect(res.data.sent).toBe(0);
    expect(res.data.failed[0]).toContain('Adresse interne refusée');
    expect(sent).toHaveLength(0);
    await setSetting(t.ctx.db, userId, 'notifications.channels', { email: { enabled: false, to: '' }, telegram: { enabled: false, chatId: '' }, ntfy: { enabled: true, server: 'https://ntfy.example', topic: 'sujet' }, webhook: { enabled: true, url: 'https://hooks.example/en-panne' } });
    await setSetting(t.ctx.db, userId, 'notifications.immediate', ['interview', 'source_down']);
    await notifyUrgent(uctx());
    const failed = await t.ctx.db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.status, 'failed')));
    expect(failed).toHaveLength(1);
    expect(failed[0]!.channel).toBe('webhook');
  });

  it('compose le résumé du jour et ne l’envoie qu’une fois par jour, à l’heure locale choisie', async () => {
    const digest = await buildDigest(uctx());
    expect(digest.title).toContain('action(s) à valider');
    expect(digest.body).toContain('candidature(s) envoyée(s) depuis hier');
    expect(digest.body).toContain('Budget IA du mois');
    expect(localClock(new Date('2026-11-13T07:30:00Z'), 'Europe/Paris')).toEqual({ hour: 8, minute: 30, day: '2026-11-13' });
    expect(localClock(new Date('2026-07-13T22:30:00Z'), 'Europe/Paris')).toEqual({ hour: 0, minute: 30, day: '2026-07-14' });
    await setSetting(t.ctx.db, userId, 'schedule.digest', { enabled: true, hour: 8, minute: 0 });
    await t.ctx.db.delete(tasks).where(eq(tasks.userId, userId));
    t.clock.set('2026-11-14T05:30:00Z'); // 6 h 30 à Paris : trop tôt
    await schedulerTick(t.ctx);
    expect(await t.ctx.db.select().from(tasks).where(and(eq(tasks.userId, userId), eq(tasks.type, 'digest.daily')))).toHaveLength(0);
    t.clock.set('2026-11-14T07:05:00Z'); // 8 h 05 à Paris
    await schedulerTick(t.ctx);
    t.clock.set('2026-11-14T09:00:00Z');
    await schedulerTick(t.ctx);
    expect(await t.ctx.db.select().from(tasks).where(and(eq(tasks.userId, userId), eq(tasks.type, 'digest.daily')))).toHaveLength(1);
  });
});

describe('analytique et données', () => {
  it('calcule l’entonnoir et les coûts', async () => {
    const res = await api.get('/api/overview/analytics');
    expect(res.status).toBe(200);
    expect(res.data.funnel[0]).toEqual({ label: 'Offres trouvées', value: 2 });
    expect(res.data.funnel.find((f: any) => f.label === 'Candidatures envoyées').value).toBe(1);
    expect(res.data.sources[0]).toMatchObject({ name: 'Ajout manuel', jobs: 2, applied: 1 });
    expect(res.data.rates.interviewRate).toBe(0);
  });

  it('exporte tout ce que l’application sait, sans aucun secret', async () => {
    await setSecret(t.ctx.db, t.ctx.env.appSecret, userId, 'anthropic_api_key', 'sk-ant-valeur-tres-secrete');
    const data = await exportUserData(uctx(), { files: false });
    expect(data.format).toBe('jobagent-export/1');
    expect((data.jobs as unknown[]).length).toBe(2);
    expect((data.cvVersions as unknown[]).length).toBe(1);
    expect((data.applications as unknown[]).length).toBe(1);
    expect(data.secretsConfigured).toEqual(expect.arrayContaining(['anthropic_api_key', 'webhook_secret']));
    const text = JSON.stringify(data);
    expect(text).not.toContain('sk-ant-valeur-tres-secrete');
    expect(text).not.toContain('signature-secrete');
    expect(text).not.toContain('passwordHash');
    expect(text).not.toContain('dataBase64');
    const http = await api.get('/api/settings/data/export?files=1');
    expect(http.status).toBe(200);
    expect(http.headers.get('content-disposition')).toContain('jobagent-export-');
  });

  it('efface à la demande, après vérification du mot de passe, en conservant ce qui doit l’être', async () => {
    expect((await api.post('/api/settings/data/delete', { scope: 'search', password: 'mauvais' })).status).toBe(400);
    expect(await t.ctx.db.select().from(jobs).where(eq(jobs.userId, userId))).toHaveLength(2);
    const res = await api.post('/api/settings/data/delete', { scope: 'search', password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.data.removed.jobs).toBe(2);
    expect(await t.ctx.db.select().from(jobs).where(eq(jobs.userId, userId))).toHaveLength(0);
    // Le profil est intact.
    expect(await t.ctx.db.select().from(cvVersions).where(and(eq(cvVersions.userId, userId), eq(cvVersions.kind, 'master')))).toHaveLength(1);
    const all = await api.post('/api/settings/data/delete', { scope: 'all', password: TEST_PASSWORD });
    expect(all.status).toBe(200);
    expect(await t.ctx.db.select().from(cvVersions).where(eq(cvVersions.userId, userId))).toHaveLength(0);
    expect((await exportUserData(uctx())).secretsConfigured).toEqual([]);
    // Le compte reste utilisable et repart de la mise en route.
    expect((await api.get('/api/auth/status')).data.user.id).toBe(userId);
    expect((await api.get('/api/inbox')).data.items.some((i: any) => i.type === 'setup.cv_master')).toBe(true);
  });
});
