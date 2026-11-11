// Enregistrement du module documents.
import { errorMessage } from '../core/log.js';
import { onMasterApproved } from '../profile/cv.js';
import { renderCvVersion } from './generate.js';

// À chaque validation d'un CV master : le template de CV est constitué ou mis à jour, et le
// master lui-même est rendu dans ce template (aperçu, et PDF utilisable tel quel).
onMasterApproved(async (ctx, master) => {
  try {
    await renderCvVersion(ctx, master.id);
  } catch (err) {
    // Le rendu ne doit jamais empêcher la validation du master ; il sera retenté à la première génération.
    ctx.log.warn('master_render_failed', { cv: master.id, error: errorMessage(err) });
  }
});
