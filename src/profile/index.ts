// Enregistrement du module profil : initialisation d'un nouvel utilisateur.
import { raiseAction } from '../core/inbox.js';
import { ensureDefaultAtsPrompt } from './ats-prompt.js';
import { registerBootstrapStep } from './bootstrap.js';
import { registerRecurringJob } from '../pipeline/scheduler.js';
import { registerTaskHandler } from '../pipeline/worker.js';
import { enqueue } from '../core/queue.js';
import { getSecret } from '../core/secrets.js';
import { getSetting } from '../core/settings.js';
import { syncLinkedinApi } from './linkedin/service.js';

registerBootstrapStep(async (ctx, userId) => {
  await ensureDefaultAtsPrompt(ctx.db, userId);
  await raiseAction(ctx.db, {
    userId,
    type: 'setup.cv_master',
    title: 'Importer votre CV master',
    body: { text: "Votre CV de référence : toutes les candidatures en dérivent, et rien n'y sera jamais ajouté sans votre accord.", link: '/profil/cv' },
    priority: 100,
    dedupKey: 'setup.cv_master',
  });
  if (ctx.env.llmProvider === 'anthropic' && !ctx.env.anthropicApiKey) {
    await raiseAction(ctx.db, {
      userId,
      type: 'setup.llm_key',
      title: "Ajouter votre clé d'API Anthropic",
      body: { text: "Nécessaire pour l'analyse ATS, la personnalisation du CV et les lettres. Elle est chiffrée et son usage est plafonné par votre budget.", link: '/parametres/ia' },
      priority: 98,
      dedupKey: 'setup.llm_key',
    });
  }
  await raiseAction(ctx.db, {
    userId,
    type: 'setup.ats_prompt',
    title: 'Coller votre prompt ATS personnel',
    body: { text: "Un prompt par défaut est actif en attendant. Le vôtre sera exécuté tel quel, sans être réécrit, et chaque version sera conservée.", link: '/profil/prompt-ats' },
    priority: 90,
    dedupKey: 'setup.ats_prompt',
  });
});

// Vérification périodique du profil LinkedIn par l'API officielle (si activée et jeton présent).
registerTaskHandler('linkedin.sync', async (ctx) => {
  const res = await syncLinkedinApi(ctx);
  return { changed: res.changed, newDiffs: res.newDiffs, autoApplied: res.autoApplied };
});

registerRecurringJob({
  name: 'linkedin.sync',
  async isDue(ctx, userId, lastRunAt, now) {
    const s = await getSetting(ctx.db, userId, 'linkedin.sync');
    if (!s.enabled) return false;
    if (lastRunAt && now.getTime() - lastRunAt.getTime() < s.intervalDays * 86400_000) return false;
    return Boolean(await getSecret(ctx.db, ctx.env.appSecret, userId, 'linkedin_access_token'));
  },
  async run(ctx, userId, now) {
    await enqueue(ctx.db, { type: 'linkedin.sync', userId, idempotencyKey: `linkedin.sync:${userId}`, runAfter: now, priority: 20, maxAttempts: 3 });
  },
});
