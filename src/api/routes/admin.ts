// Gestion des utilisateurs (réservée au propriétaire de l'instance). Chaque
// utilisateur dispose d'un espace entièrement isolé : le propriétaire administre
// les comptes mais n'a aucun accès aux données des autres.
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { createUser, revokeAllSessions } from '../../auth/service.js';
import { logActivity } from '../../core/activity.js';
import { badRequest, notFound } from '../../core/errors.js';
import { users } from '../../db/schema.js';
import { bootstrapUser } from '../../profile/bootstrap.js';
import { type AppDeps, body, router } from '../http.js';
import { ownerOnly, sessionOnly } from '../middleware.js';

export function adminRoutes(deps: AppDeps) {
  const r = router();
  const { ctx } = deps;
  r.use('*', sessionOnly, ownerOnly);

  r.get('/users', async (c) => {
    const rows = await ctx.db.select({ id: users.id, email: users.email, name: users.name, role: users.role, createdAt: users.createdAt, lastLoginAt: users.lastLoginAt, disabledAt: users.disabledAt, totpEnabled: users.totpEnabled }).from(users);
    return c.json({ users: rows });
  });

  r.post('/users', async (c) => {
    const input = await body(c, z.object({ email: z.string(), name: z.string().optional(), password: z.string() }));
    const user = await createUser(ctx.db, { email: input.email, name: input.name, password: input.password, role: 'user' });
    await bootstrapUser(ctx, user.id);
    await logActivity(ctx.db, { userId: c.get('user').id, actor: 'user', action: 'admin.user_created', entityType: 'user', entityId: user.id, summary: `Compte créé : ${user.email}` });
    return c.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  });

  r.post('/users/:id/disable', async (c) => {
    const id = c.req.param('id');
    if (id === c.get('user').id) throw badRequest('Vous ne pouvez pas désactiver votre propre compte.');
    const [row] = await ctx.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, id)).returning({ id: users.id, email: users.email });
    if (!row) throw notFound();
    await revokeAllSessions(ctx.db, id);
    await logActivity(ctx.db, { userId: c.get('user').id, actor: 'user', action: 'admin.user_disabled', entityType: 'user', entityId: id, summary: `Compte désactivé : ${row.email}`, level: 'warn' });
    return c.json({ ok: true });
  });

  r.post('/users/:id/enable', async (c) => {
    const [row] = await ctx.db.update(users).set({ disabledAt: null }).where(eq(users.id, c.req.param('id'))).returning({ id: users.id });
    if (!row) throw notFound();
    return c.json({ ok: true });
  });

  return r;
}
