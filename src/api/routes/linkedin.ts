import { z } from 'zod';
import { badRequest } from '../../core/errors.js';
import { enqueue } from '../../core/queue.js';
import { decideDiff, importLinkedinFile, lastSnapshot, listDiffs, syncLinkedinApi } from '../../profile/linkedin/service.js';
import { type AppDeps, body, router } from '../http.js';
import { sessionOnly } from '../middleware.js';

export function linkedinRoutes(deps: AppDeps) {
  const r = router();

  r.get('/', async (c) => {
    const uctx = c.get('uctx');
    const [snapshot, open, decided] = await Promise.all([lastSnapshot(uctx), listDiffs(uctx, ['open']), listDiffs(uctx, ['accepted', 'rejected', 'ignored'])]);
    return c.json({
      snapshot: snapshot ? { id: snapshot.id, method: snapshot.method, fetchedAt: snapshot.fetchedAt, experiences: snapshot.data.experiences.length, education: snapshot.data.education.length, skills: snapshot.data.skills.flatMap((s) => s.items).length, headline: snapshot.data.identity.headline } : null,
      diffs: open,
      history: decided.slice(0, 50),
    });
  });

  r.post('/import', sessionOnly, async (c) => {
    const form = await c.req.parseBody();
    const f = form.file;
    if (!(f instanceof File)) throw badRequest('Aucun fichier reçu.');
    const res = await importLinkedinFile(c.get('uctx'), { filename: f.name || 'linkedin', mime: f.type || '', data: new Uint8Array(await f.arrayBuffer()) });
    return c.json(res);
  });

  r.post('/import-text', sessionOnly, async (c) => {
    const input = await body(c, z.object({ text: z.string().min(80, 'Texte trop court.') }));
    const res = await importLinkedinFile(c.get('uctx'), { filename: 'linkedin.txt', mime: 'text/plain', data: new TextEncoder().encode(input.text) });
    return c.json(res);
  });

  /** Synchronisation immédiate par l'API officielle (jeton enregistré dans les secrets). */
  r.post('/sync', sessionOnly, async (c) => c.json(await syncLinkedinApi(c.get('uctx'))));

  r.post('/diffs/:id', sessionOnly, async (c) => {
    const input = await body(c, z.object({ decision: z.enum(['accept', 'reject', 'ignore']), selected: z.array(z.string()).optional() }));
    return c.json(await decideDiff(c.get('uctx'), c.req.param('id'), input.decision, { selected: input.selected }));
  });

  void enqueue;
  void deps;
  return r;
}
