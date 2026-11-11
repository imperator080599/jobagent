// Enregistrement du module profil : initialisation d'un nouvel utilisateur.
import { raiseAction } from '../core/inbox.js';
import { ensureDefaultAtsPrompt } from './ats-prompt.js';
import { registerBootstrapStep } from './bootstrap.js';

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
