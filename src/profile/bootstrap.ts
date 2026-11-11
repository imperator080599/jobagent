// Initialisation de l'espace d'un nouvel utilisateur : valeurs par défaut utiles
// dès la première connexion. Idempotent — peut être rejoué sans créer de doublon.
import type { AppContext } from '../core/context.js';

type Step = (ctx: AppContext, userId: string) => Promise<void>;
const steps: Step[] = [];

/** Les modules enregistrent ici leur initialisation (prompt ATS par défaut, profils de recherche, sources…). */
export function registerBootstrapStep(step: Step) {
  steps.push(step);
}

export async function bootstrapUser(ctx: AppContext, userId: string): Promise<void> {
  for (const step of steps) await step(ctx, userId);
}
