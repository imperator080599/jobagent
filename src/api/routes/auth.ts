import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import {
  SESSION_COOKIE,
  authenticate,
  beginTotpSetup,
  changePassword,
  countUsers,
  createApiToken,
  createSession,
  createUser,
  disableTotp,
  enableTotp,
  getSessionUser,
  listApiTokens,
  listSessions,
  publicUser,
  revokeAllSessions,
  revokeApiToken,
  revokeSession,
  revokeSessionByToken,
} from '../../auth/service.js';
import { hitRateLimit, isRateLimited } from '../../auth/ratelimit.js';
import { otpauthUrl } from '../../auth/totp.js';
import { logActivity } from '../../core/activity.js';
import { safeEqual } from '../../core/crypto.js';
import { badRequest, forbidden, tooMany, unauthorized } from '../../core/errors.js';
import { type AppDeps, type Ctx, body, clientIp, isHttps, router } from '../http.js';
import { requireAuth, sessionOnly } from '../middleware.js';
import { bootstrapUser } from '../../profile/bootstrap.js';

function setSessionCookie(c: Ctx, token: string, expiresAt: Date) {
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: isHttps(c), sameSite: 'Lax', path: '/', expires: expiresAt });
}

export function authRoutes(deps: AppDeps) {
  const r = router();
  const { ctx } = deps;

  /** État d'authentification : indique aussi si l'instance attend la création du premier compte. */
  r.get('/status', async (c) => {
    const n = await countUsers(ctx.db);
    const token = getCookie(c, SESSION_COOKIE);
    const session = token ? await getSessionUser(ctx.db, token) : null;
    return c.json({
      needsSetup: n === 0,
      setupTokenRequired: n === 0 && (ctx.env.isProduction || Boolean(ctx.env.setupToken)),
      user: session ? publicUser(session.user) : null,
      demo: ctx.env.llmProvider === 'mock',
    });
  });

  /** Création du compte propriétaire, possible une seule fois (instance vierge). */
  r.post('/setup', async (c) => {
    const input = await body(c, z.object({ email: z.string(), password: z.string(), name: z.string().optional(), setupToken: z.string().optional(), timezone: z.string().optional() }));
    if ((await hitRateLimit(ctx.db, `setup:${clientIp(c)}`, 600, 10, ctx.now())).limited) throw tooMany();
    if ((await countUsers(ctx.db)) > 0) throw forbidden('Cette instance est déjà configurée.');
    if (ctx.env.isProduction && !ctx.env.setupToken) throw forbidden("Définissez SETUP_TOKEN dans l'environnement pour créer le premier compte.");
    if (ctx.env.setupToken && !safeEqual(input.setupToken ?? '', ctx.env.setupToken)) throw forbidden("Jeton d'installation incorrect.");
    const user = await createUser(ctx.db, { email: input.email, password: input.password, name: input.name, role: 'owner', timezone: input.timezone });
    await bootstrapUser(ctx, user.id);
    const s = await createSession(ctx.db, user.id, { userAgent: c.req.header('user-agent'), ip: clientIp(c) });
    setSessionCookie(c, s.token, s.expiresAt);
    await logActivity(ctx.db, { userId: user.id, actor: 'user', action: 'account.created', summary: 'Compte propriétaire créé' });
    return c.json({ user: publicUser(user) });
  });

  r.post('/login', async (c) => {
    const input = await body(c, z.object({ email: z.string(), password: z.string(), totp: z.string().optional() }));
    const ip = clientIp(c);
    const now = ctx.now();
    // Seuls les échecs consomment le quota : une connexion réussie n'est jamais pénalisée.
    const ipKey = `login:ip:${ip}`;
    const emailKey = `login:email:${input.email.trim().toLowerCase()}`;
    if ((await isRateLimited(ctx.db, ipKey, 600, 20, now)) || (await isRateLimited(ctx.db, emailKey, 600, 8, now))) throw tooMany();
    const res = await authenticate(ctx.db, ctx.env.appSecret, input.email, input.password, input.totp);
    if (!res.ok) {
      if (res.reason === 'totp_required') return c.json({ totpRequired: true }, 200);
      await hitRateLimit(ctx.db, ipKey, 600, 20, now);
      await hitRateLimit(ctx.db, emailKey, 600, 8, now);
      if (res.reason === 'totp_invalid') throw unauthorized('Code de double authentification incorrect.');
      if (res.reason === 'disabled') throw forbidden('Ce compte est désactivé.');
      throw unauthorized('Email ou mot de passe incorrect.');
    }
    const s = await createSession(ctx.db, res.user.id, { userAgent: c.req.header('user-agent'), ip });
    setSessionCookie(c, s.token, s.expiresAt);
    await logActivity(ctx.db, { userId: res.user.id, actor: 'user', action: 'auth.login', summary: 'Connexion' });
    return c.json({ user: publicUser(res.user) });
  });

  r.post('/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await revokeSessionByToken(ctx.db, token);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  // ── Routes authentifiées (gestion du compte) ──
  const me = router();
  me.use('*', requireAuth, sessionOnly);

  me.get('/sessions', async (c) => c.json({ sessions: await listSessions(ctx.db, c.get('user').id), current: c.get('sessionId') }));
  me.delete('/sessions/:id', async (c) => {
    await revokeSession(ctx.db, c.get('user').id, c.req.param('id'));
    return c.json({ ok: true });
  });
  me.post('/sessions/revoke-others', async (c) => {
    await revokeAllSessions(ctx.db, c.get('user').id, c.get('sessionId'));
    return c.json({ ok: true });
  });

  me.post('/password', async (c) => {
    const input = await body(c, z.object({ current: z.string(), next: z.string() }));
    await changePassword(ctx.db, c.get('user'), input.current, input.next);
    await revokeAllSessions(ctx.db, c.get('user').id, c.get('sessionId'));
    await logActivity(ctx.db, { userId: c.get('user').id, actor: 'user', action: 'auth.password_changed', summary: 'Mot de passe modifié' });
    return c.json({ ok: true });
  });

  me.post('/totp/setup', async (c) => {
    const user = c.get('user');
    if (user.totpEnabled) throw badRequest('La double authentification est déjà active.');
    const { secret } = await beginTotpSetup(ctx.db, ctx.env.appSecret, user);
    return c.json({ secret, otpauthUrl: otpauthUrl(secret, user.email) });
  });
  me.post('/totp/enable', async (c) => {
    const input = await body(c, z.object({ code: z.string() }));
    const res = await enableTotp(ctx.db, ctx.env.appSecret, c.get('user'), input.code);
    await logActivity(ctx.db, { userId: c.get('user').id, actor: 'user', action: 'auth.totp_enabled', summary: 'Double authentification activée' });
    return c.json(res);
  });
  me.post('/totp/disable', async (c) => {
    const input = await body(c, z.object({ password: z.string() }));
    await disableTotp(ctx.db, c.get('user'), input.password);
    await logActivity(ctx.db, { userId: c.get('user').id, actor: 'user', action: 'auth.totp_disabled', summary: 'Double authentification désactivée', level: 'warn' });
    return c.json({ ok: true });
  });

  me.get('/tokens', async (c) => c.json({ tokens: await listApiTokens(ctx.db, c.get('user').id) }));
  me.post('/tokens', async (c) => {
    const input = await body(c, z.object({ name: z.string().min(1), scopes: z.array(z.enum(['apply', 'capture', 'worker'])).min(1) }));
    const t = await createApiToken(ctx.db, c.get('user').id, input.name, input.scopes);
    await logActivity(ctx.db, { userId: c.get('user').id, actor: 'user', action: 'auth.token_created', summary: `Jeton d'API créé : ${input.name}` });
    return c.json(t);
  });
  me.delete('/tokens/:id', async (c) => {
    await revokeApiToken(ctx.db, c.get('user').id, c.req.param('id'));
    return c.json({ ok: true });
  });

  r.route('/', me);
  return r;
}
