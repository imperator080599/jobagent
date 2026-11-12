import { z } from 'zod';
import { listActivity } from '../../core/activity.js';
import { badRequest } from '../../core/errors.js';
import { SECRET_KEYS, type SecretKey, deleteSecret, listSecretHints, setSecret } from '../../core/secrets.js';
import { getAllSettings, setSetting } from '../../core/settings.js';
import { logActivity } from '../../core/activity.js';
import { isSettingKey } from '../../shared/settings.js';
import { resolveAction } from '../../core/inbox.js';
import { unblockByReason } from '../../core/queue.js';
import { type AppDeps, body, router } from '../http.js';
import { sessionOnly } from '../middleware.js';

export function settingsRoutes(deps: AppDeps) {
  const r = router();
  const { ctx } = deps;

  r.get('/', async (c) => {
    const userId = c.get('user').id;
    const [values, secretHints] = await Promise.all([getAllSettings(ctx.db, userId), listSecretHints(ctx.db, userId)]);
    return c.json({
      settings: values,
      secrets: secretHints,
      env: { llmProvider: ctx.env.llmProvider, anthropicKeyFromEnv: Boolean(ctx.env.anthropicApiKey), serverless: ctx.env.isServerless },
    });
  });

  r.put('/:key', sessionOnly, async (c) => {
    const key = c.req.param('key');
    if (!isSettingKey(key)) throw badRequest(`Paramètre inconnu : ${key}`);
    const input = await body(c, z.object({ value: z.unknown() }));
    const value = await setSetting(ctx.db, c.get('user').id, key, input.value);
    // Un budget relevé ou un plafond modifié libère les tâches mises en attente pour ce motif.
    if (key === 'llm.budget') await unblockByReason(ctx.db, c.get('user').id, ['llm_budget_month', 'llm_budget_day']);
    deps.kick(c);
    return c.json({ key, value });
  });

  /** Enregistre un secret (chiffré). La valeur n'est jamais renvoyée par l'API. */
  r.put('/secrets/:key', sessionOnly, async (c) => {
    const key = c.req.param('key') as SecretKey;
    if (!SECRET_KEYS.includes(key)) throw badRequest(`Secret inconnu : ${key}`);
    const input = await body(c, z.object({ value: z.string().min(1).max(4000) }));
    await setSecret(ctx.db, ctx.env.appSecret, c.get('user').id, key, input.value.trim());
    await logActivity(ctx.db, { userId: c.get('user').id, actor: 'user', action: 'secret.updated', entityType: 'secret', entityId: key, summary: `Secret « ${key} » enregistré` });
    if (key === 'anthropic_api_key') {
      await resolveAction(ctx.db, c.get('user').id, { dedupKey: 'setup.llm_key' }, { configured: true });
      await unblockByReason(ctx.db, c.get('user').id, ['llm_key_missing', 'llm_key_invalid']);
    } else {
      // Identifiants d'une source : les collectes en attente reprennent.
      await unblockByReason(ctx.db, c.get('user').id, ['source_credentials']);
    }
    deps.kick(c);
    return c.json({ ok: true });
  });

  r.delete('/secrets/:key', sessionOnly, async (c) => {
    const key = c.req.param('key') as SecretKey;
    if (!SECRET_KEYS.includes(key)) throw badRequest(`Secret inconnu : ${key}`);
    await deleteSecret(ctx.db, c.get('user').id, key);
    await logActivity(ctx.db, { userId: c.get('user').id, actor: 'user', action: 'secret.deleted', entityType: 'secret', entityId: key, summary: `Secret « ${key} » supprimé` });
    return c.json({ ok: true });
  });

  r.get('/activity', async (c) => {
    const before = c.req.query('before');
    const items = await listActivity(ctx.db, c.get('user').id, {
      limit: Number(c.req.query('limit') ?? 100),
      before: before ? new Date(before) : undefined,
      entityType: c.req.query('entityType') || undefined,
      entityId: c.req.query('entityId') || undefined,
    });
    return c.json({ items });
  });

  return r;
}
