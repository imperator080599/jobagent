import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { TEST_PASSWORD, client, makeTestEnv, signedIn, type TestEnv } from '../helpers.js';
import { blockTask, claimNext, completeTask, enqueue, failTask, queueStats, requeueStale, unblockTasks } from '../../src/core/queue.js';
import { rateLimits, secrets, sessions, tasks, users } from '../../src/db/schema.js';
import { getSecret } from '../../src/core/secrets.js';
import { getSetting, setSetting } from '../../src/core/settings.js';
import { totpCode } from '../../src/auth/totp.js';
import { registerTaskHandler, runWorker } from '../../src/pipeline/worker.js';
import { NeedsHumanError } from '../../src/core/errors.js';

let t: TestEnv;
beforeAll(async () => {
  t = await makeTestEnv();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.ctx.db.delete(rateLimits);
});

describe('authentification', () => {
  it('crée le compte propriétaire une seule fois puis ouvre une session', async () => {
    const api = client(t.app);
    const status = await api.get('/api/auth/status');
    expect(status.data).toMatchObject({ needsSetup: true, user: null });

    expect((await api.get('/api/me')).status).toBe(401);
    const weak = await api.post('/api/auth/setup', { email: 'a@b.test', password: 'court' });
    expect(weak.status).toBe(400);

    const ok = await api.post('/api/auth/setup', { email: 'Owner@Example.test', password: TEST_PASSWORD, name: 'Camille' });
    expect(ok.status).toBe(200);
    expect(ok.data.user).toMatchObject({ email: 'owner@example.test', role: 'owner' });
    expect(ok.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    expect(ok.headers.get('set-cookie')).toMatch(/SameSite=Lax/i);

    const me = await api.get('/api/me');
    expect(me.data.user.email).toBe('owner@example.test');

    const again = await client(t.app).post('/api/auth/setup', { email: 'intrus@example.test', password: TEST_PASSWORD });
    expect(again.status).toBe(403);
  });

  it('ne stocke ni mot de passe ni jeton de session en clair', async () => {
    const [u] = await t.ctx.db.select().from(users);
    expect(u!.passwordHash).not.toContain(TEST_PASSWORD);
    expect(u!.passwordHash.startsWith('scrypt$')).toBe(true);
    const api = client(t.app);
    const res = await api.post('/api/auth/login', { email: 'owner@example.test', password: TEST_PASSWORD });
    const token = /ja_session=([^;]+)/.exec(res.headers.get('set-cookie')!)![1]!;
    const rows = await t.ctx.db.select().from(sessions);
    expect(rows.some((s) => s.tokenHash === token)).toBe(false);
  });

  it('refuse un mauvais mot de passe sans révéler si le compte existe', async () => {
    const api = client(t.app);
    const a = await api.post('/api/auth/login', { email: 'owner@example.test', password: 'mauvais-mot-de-passe' });
    const b = await api.post('/api/auth/login', { email: 'inconnu@example.test', password: 'mauvais-mot-de-passe' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.data.error.message).toBe(b.data.error.message);
  });

  it('bloque les requêtes modifiantes sans en-tête anti-CSRF ou d’une autre origine', async () => {
    const api = client(t.app);
    await api.post('/api/auth/login', { email: 'owner@example.test', password: TEST_PASSWORD });
    const noHeader = await api.raw('PUT', '/api/settings/application.mode', { value: 'autonomous' }, { 'x-jobagent-client': '' });
    expect(noHeader.status).toBe(403);
    const crossOrigin = await api.raw('PUT', '/api/settings/application.mode', { value: 'autonomous' }, { origin: 'https://evil.example', host: 'app.example' });
    expect(crossOrigin.status).toBe(403);
    const sameOrigin = await api.raw('PUT', '/api/settings/application.mode', { value: 'validation' }, { origin: 'https://app.example', host: 'app.example' });
    expect(sameOrigin.status).toBe(200);
  });

  it('limite les tentatives de connexion', async () => {
    const api = client(t.app);
    let last = 0;
    for (let i = 0; i < 10; i++) last = (await api.post('/api/auth/login', { email: 'victime@example.test', password: 'x'.repeat(14) })).status;
    expect(last).toBe(429);
    // Le blocage vise l'adresse attaquée : un autre compte reste accessible depuis la même IP.
    expect((await client(t.app).post('/api/auth/login', { email: 'owner@example.test', password: TEST_PASSWORD })).status).toBe(200);
    // …et la fenêtre expire d'elle-même.
    t.clock.advance(11 * 60_000);
    expect((await api.post('/api/auth/login', { email: 'victime@example.test', password: 'x'.repeat(14) })).status).toBe(401);
  });

  it('gère la double authentification TOTP et les codes de secours', async () => {
    const api = client(t.app);
    await api.post('/api/auth/login', { email: 'owner@example.test', password: TEST_PASSWORD });
    const setup = await api.post('/api/auth/totp/setup');
    expect(setup.data.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect((await api.post('/api/auth/totp/enable', { code: '000000' })).status).toBe(400);
    const enabled = await api.post('/api/auth/totp/enable', { code: totpCode(setup.data.secret) });
    expect(enabled.data.recoveryCodes).toHaveLength(8);

    const fresh = client(t.app);
    const step1 = await fresh.post('/api/auth/login', { email: 'owner@example.test', password: TEST_PASSWORD });
    expect(step1.data).toEqual({ totpRequired: true });
    expect((await fresh.get('/api/me')).status).toBe(401);
    expect((await fresh.post('/api/auth/login', { email: 'owner@example.test', password: TEST_PASSWORD, totp: '123456' })).status).toBe(401);
    expect((await fresh.post('/api/auth/login', { email: 'owner@example.test', password: TEST_PASSWORD, totp: totpCode(setup.data.secret) })).status).toBe(200);

    // Un code de secours fonctionne une fois, pas deux.
    const rc = enabled.data.recoveryCodes[0];
    expect((await client(t.app).post('/api/auth/login', { email: 'owner@example.test', password: TEST_PASSWORD, totp: rc })).status).toBe(200);
    expect((await client(t.app).post('/api/auth/login', { email: 'owner@example.test', password: TEST_PASSWORD, totp: rc })).status).toBe(401);

    expect((await api.post('/api/auth/totp/disable', { password: TEST_PASSWORD })).status).toBe(200);
  });

  it('émet des jetons d’API à portée limitée, révocables', async () => {
    const api = client(t.app);
    await api.post('/api/auth/login', { email: 'owner@example.test', password: TEST_PASSWORD });
    const tok = await api.post('/api/auth/tokens', { name: 'Extension', scopes: ['apply'] });
    expect(tok.data.token).toMatch(/^ja_/);
    const bearer = { authorization: `Bearer ${tok.data.token}`, 'x-jobagent-client': '' };
    const anon = client(t.app);
    expect((await anon.get('/api/me', bearer)).status).toBe(200);
    // Un jeton ne peut pas modifier les paramètres ni gérer le compte.
    expect((await anon.raw('PUT', '/api/settings/application.mode', { value: 'autonomous' }, bearer)).status).toBe(403);
    expect((await anon.get('/api/auth/tokens', bearer)).status).toBe(403);
    await api.del(`/api/auth/tokens/${tok.data.id}`);
    expect((await anon.get('/api/me', bearer)).status).toBe(401);
  });

  it('déconnecte et invalide la session côté serveur', async () => {
    const api = client(t.app);
    const res = await api.post('/api/auth/login', { email: 'owner@example.test', password: TEST_PASSWORD });
    const cookie = /ja_session=[^;]+/.exec(res.headers.get('set-cookie')!)![0]!;
    await api.post('/api/auth/logout');
    const replay = await client(t.app).get('/api/me', { cookie });
    expect(replay.status).toBe(401);
  });
});

describe('paramètres et secrets', () => {
  it('renvoie les valeurs par défaut, valide et journalise les modifications', async () => {
    const api = client(t.app);
    await api.post('/api/auth/login', { email: 'owner@example.test', password: TEST_PASSWORD });
    const all = await api.get('/api/settings');
    expect(all.data.settings['application.mode']).toBe('validation');
    expect(all.data.settings['ats.thresholds']).toEqual({ excellent: 15, interesting: 13, limited: 11 });

    expect((await api.put('/api/settings/application.mode', { value: 'nimporte' })).status).toBe(400);
    expect((await api.put('/api/settings/inconnu', { value: 1 })).status).toBe(400);
    // Mise à jour partielle : les champs absents gardent leur valeur par défaut.
    const partial = await api.put('/api/settings/ats.policy', { value: { maxPerDay: 3 } });
    expect(partial.data.value).toEqual({ minRelevance: 60, maxPerDay: 3, requestFeedbackFrom: 11 });

    const log = await api.get('/api/settings/activity?entityType=setting');
    expect(log.data.items.some((i: any) => i.entityId === 'ats.policy' && i.data.after.maxPerDay === 3)).toBe(true);
  });

  it('chiffre les secrets et ne les renvoie jamais', async () => {
    const api = client(t.app);
    const login = await api.post('/api/auth/login', { email: 'owner@example.test', password: TEST_PASSWORD });
    const userId = login.data.user.id;
    await api.put('/api/settings/secrets/anthropic_api_key', { value: 'sk-ant-test-0123456789abcd' });
    const all = await api.get('/api/settings');
    expect(all.data.secrets.anthropic_api_key.hint).toBe('••••abcd');
    expect(JSON.stringify(all.data)).not.toContain('sk-ant-test');
    const [row] = await t.ctx.db.select().from(secrets).where(eq(secrets.userId, userId));
    expect(row!.ciphertext).not.toContain('sk-ant-test');
    expect(await getSecret(t.ctx.db, t.ctx.env.appSecret, userId, 'anthropic_api_key')).toBe('sk-ant-test-0123456789abcd');
    expect((await api.put('/api/settings/secrets/inconnu', { value: 'x' })).status).toBe(400);
  });

  it('isole les paramètres par utilisateur', async () => {
    const [owner] = await t.ctx.db.select().from(users);
    await setSetting(t.ctx.db, owner!.id, 'application.dryRun', true);
    expect(await getSetting(t.ctx.db, owner!.id, 'application.dryRun')).toBe(true);
    expect(await getSetting(t.ctx.db, 'usr_autre', 'application.dryRun')).toBe(false);
  });
});

describe('file de tâches', () => {
  it('garantit une seule tâche active par clé d’idempotence', async () => {
    const a = await enqueue(t.ctx.db, { type: 'test.noop', userId: null, idempotencyKey: 'k1' });
    const b = await enqueue(t.ctx.db, { type: 'test.noop', userId: null, idempotencyKey: 'k1' });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    await completeTask(t.ctx.db, a!.id);
    // Une fois terminée, la même clé peut être replanifiée.
    const c = await enqueue(t.ctx.db, { type: 'test.noop', userId: null, idempotencyKey: 'k1' });
    expect(c).not.toBeNull();
    await completeTask(t.ctx.db, c!.id);
  });

  it('distribue par priorité, sans jamais donner la même tâche deux fois', async () => {
    await t.ctx.db.delete(tasks);
    await enqueue(t.ctx.db, { type: 'test.order', userId: null, payload: { n: 'bas' }, priority: 10 });
    await enqueue(t.ctx.db, { type: 'test.order', userId: null, payload: { n: 'haut' }, priority: 90 });
    await enqueue(t.ctx.db, { type: 'test.order', userId: null, payload: { n: 'futur' }, priority: 99, runAfter: new Date(t.clock.now.getTime() + 3600_000) });
    const claimed = await Promise.all([1, 2, 3].map((i) => claimNext(t.ctx.db, { workerId: `w${i}`, now: t.ctx.now() })));
    const got = claimed.filter(Boolean).map((x) => x!.payload.n);
    expect(got.sort()).toEqual(['bas', 'haut']);
    expect(new Set(claimed.filter(Boolean).map((x) => x!.id)).size).toBe(2);
    const first = await t.ctx.db.select().from(tasks).where(eq(tasks.status, 'running'));
    expect(first).toHaveLength(2);
  });

  it('réessaie avec un délai croissant puis échoue définitivement', async () => {
    await t.ctx.db.delete(tasks);
    await enqueue(t.ctx.db, { type: 'test.fail', userId: null, maxAttempts: 2 });
    let task = (await claimNext(t.ctx.db, { workerId: 'w', now: t.ctx.now() }))!;
    expect(await failTask(t.ctx.db, task, 'boom', { now: t.ctx.now() })).toBe('retry');
    expect(await claimNext(t.ctx.db, { workerId: 'w', now: t.ctx.now() })).toBeNull(); // pas encore dû
    t.clock.advance(3 * 60_000);
    task = (await claimNext(t.ctx.db, { workerId: 'w', now: t.ctx.now() }))!;
    expect(task.attempts).toBe(2);
    expect(await failTask(t.ctx.db, task, 'boom', { now: t.ctx.now() })).toBe('failed');
    expect((await queueStats(t.ctx.db)).failed).toBe(1);
  });

  it('reprend les tâches orphelines après une interruption', async () => {
    await t.ctx.db.delete(tasks);
    await enqueue(t.ctx.db, { type: 'test.stale', userId: null });
    const task = (await claimNext(t.ctx.db, { workerId: 'mort', now: t.ctx.now() }))!;
    expect(await requeueStale(t.ctx.db, { now: t.ctx.now() })).toBe(0);
    t.clock.advance(20 * 60_000);
    expect(await requeueStale(t.ctx.db, { now: t.ctx.now() })).toBe(1);
    const again = (await claimNext(t.ctx.db, { workerId: 'vivant', now: t.ctx.now() }))!;
    expect(again.id).toBe(task.id);
    expect(again.attempts).toBe(2);
  });

  it('met en attente les tâches qui exigent une intervention humaine, puis les reprend', async () => {
    await t.ctx.db.delete(tasks);
    let humanDone = false;
    const seen: string[] = [];
    registerTaskHandler('test.human', async (_ctx, task) => {
      seen.push(task.id);
      if (!humanDone) throw new NeedsHumanError('CAPTCHA à résoudre', 'captcha');
      return { ok: true };
    });
    await enqueue(t.ctx.db, { type: 'test.human', userId: null, idempotencyKey: 'human-1' });
    const r1 = await runWorker(t.ctx, { budgetMs: 5_000, workerId: 'w' });
    expect(r1).toMatchObject({ processed: 1, blocked: 1 });
    // Bloquée : ni réessayée en boucle, ni dupliquée.
    expect((await runWorker(t.ctx, { budgetMs: 5_000, workerId: 'w' })).processed).toBe(0);
    expect(await enqueue(t.ctx.db, { type: 'test.human', userId: null, idempotencyKey: 'human-1' })).toBeNull();
    humanDone = true;
    expect(await unblockTasks(t.ctx.db, 'human-1')).toBe(1);
    expect((await runWorker(t.ctx, { budgetMs: 5_000, workerId: 'w' })).processed).toBe(1);
    expect(new Set(seen).size).toBe(1);
    expect((await queueStats(t.ctx.db)).done).toBe(1);
    void blockTask;
  });
});
