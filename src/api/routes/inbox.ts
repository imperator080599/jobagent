// Centre de validation : liste et traitement des demandes d'intervention.
import { z } from 'zod';
import { notFound } from '../../core/errors.js';
import { getAction, listOpenActions, resolveAction, snoozeAction } from '../../core/inbox.js';
import { type AppDeps, body, router } from '../http.js';
import { sessionOnly } from '../middleware.js';

export function inboxRoutes(deps: AppDeps) {
  const r = router();
  const { ctx } = deps;

  r.get('/', async (c) => c.json({ items: await listOpenActions(ctx.db, c.get('user').id, { now: ctx.now() }) }));

  r.post('/:id/dismiss', sessionOnly, async (c) => {
    const n = await resolveAction(ctx.db, c.get('user').id, { id: c.req.param('id') }, { by: 'user' }, 'dismissed');
    if (!n) throw notFound();
    return c.json({ ok: true });
  });

  r.post('/:id/done', sessionOnly, async (c) => {
    const n = await resolveAction(ctx.db, c.get('user').id, { id: c.req.param('id') }, { by: 'user' }, 'done');
    if (!n) throw notFound();
    return c.json({ ok: true });
  });

  r.post('/:id/snooze', sessionOnly, async (c) => {
    const input = await body(c, z.object({ hours: z.number().min(1).max(24 * 30) }));
    const item = await getAction(ctx.db, c.get('user').id, c.req.param('id'));
    if (!item) throw notFound();
    await snoozeAction(ctx.db, c.get('user').id, item.id, new Date(ctx.now().getTime() + input.hours * 3600_000));
    return c.json({ ok: true });
  });

  return r;
}
