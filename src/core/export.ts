// Portabilité et effacement des données. L'export contient tout ce que l'application
// sait de l'utilisateur, dans un format lisible (JSON) ; les secrets n'en font jamais
// partie. Les fichiers binaires (PDF, Word) peuvent être inclus pour une sauvegarde complète.
import { and, desc, eq, sql } from 'drizzle-orm';
import type { UserContext } from './context.js';
import { logActivity } from './activity.js';
import * as t from '../db/schema.js';

const OWNED = {
  settings: t.settings,
  profileFacts: t.profileFacts,
  qaAnswers: t.qaAnswers,
  atsPrompts: t.atsPrompts,
  cvVersions: t.cvVersions,
  templates: t.templates,
  feedback: t.feedback,
  linkedinSnapshots: t.linkedinSnapshots,
  profileDiffs: t.profileDiffs,
  searchProfiles: t.searchProfiles,
  companies: t.companies,
  sources: t.sources,
  jobs: t.jobs,
  jobSightings: t.jobSightings,
  stageHistory: t.stageHistory,
  atsAnalyses: t.atsAnalyses,
  letters: t.letters,
  applications: t.applications,
  applicationAttempts: t.applicationAttempts,
  actionItems: t.actionItems,
  emails: t.emails,
  drafts: t.drafts,
  interviews: t.interviews,
  contacts: t.contacts,
} as const;

/** Toute table portant un identifiant et un propriétaire : seules ces deux colonnes servent ici. */
type OwnedTable = typeof t.jobs;
const owned = (table: unknown) => table as OwnedTable;

export const EXPORT_FORMAT = 'jobagent-export/1';

export async function exportUserData(ctx: UserContext, opts: { files?: boolean } = {}): Promise<Record<string, unknown>> {
  const [user] = await ctx.db.select({ id: t.users.id, email: t.users.email, name: t.users.name, role: t.users.role, timezone: t.users.timezone, locale: t.users.locale, createdAt: t.users.createdAt }).from(t.users).where(eq(t.users.id, ctx.userId));
  const out: Record<string, unknown> = { format: EXPORT_FORMAT, exportedAt: ctx.now().toISOString(), user };
  for (const [name, table] of Object.entries(OWNED)) {
    const owned = table as unknown as OwnedTable;
    out[name] = await ctx.db.select().from(owned).where(eq(owned.userId, ctx.userId));
  }
  out.sourceRuns = await ctx.db.select().from(t.sourceRuns).where(eq(t.sourceRuns.userId, ctx.userId)).orderBy(desc(t.sourceRuns.startedAt)).limit(500);
  out.activityLog = await ctx.db.select().from(t.activityLog).where(eq(t.activityLog.userId, ctx.userId)).orderBy(desc(t.activityLog.at)).limit(5000);
  out.llmCalls = await ctx.db
    .select({ purpose: t.llmCalls.purpose, model: t.llmCalls.model, calls: sql<number>`count(*)::int`, costUsd: sql<number>`coalesce(sum(${t.llmCalls.costUsd}), 0)::float8` })
    .from(t.llmCalls)
    .where(eq(t.llmCalls.userId, ctx.userId))
    .groupBy(t.llmCalls.purpose, t.llmCalls.model);
  const files = await ctx.db.select().from(t.files).where(eq(t.files.userId, ctx.userId));
  out.files = files.map((f) => ({ id: f.id, kind: f.kind, filename: f.filename, mime: f.mime, size: f.size, sha256: f.sha256, refType: f.refType, refId: f.refId, createdAt: f.createdAt, ...(opts.files ? { dataBase64: Buffer.from(f.data).toString('base64') } : {}) }));
  // Les secrets (clés d'API, jetons) ne sont jamais exportés : seule leur liste figure ici.
  out.secretsConfigured = (await ctx.db.select({ key: t.secrets.key }).from(t.secrets).where(eq(t.secrets.userId, ctx.userId))).map((s) => s.key);
  return out;
}

/**
 * Efface des données de l'utilisateur.
 *  - `search` : offres, candidatures, documents de candidature, emails, historique des collectes.
 *    Le profil (CV master, informations, prompt, templates) est conservé.
 *  - `all` : tout, sauf le compte lui-même et ses réglages de sécurité.
 */
export async function deleteUserData(ctx: UserContext, scope: 'search' | 'all'): Promise<Record<string, number>> {
  const removed: Record<string, number> = {};
  // Tout se fait dans une seule transaction, sur sa propre connexion : soit tout est effacé, soit rien.
  await ctx.db.transaction(async (tx) => {
    const wipe = async (name: string, raw: unknown, extra?: ReturnType<typeof and>) => {
      const table = owned(raw);
      const rows = await tx.delete(table).where(extra ? and(eq(table.userId, ctx.userId), extra) : eq(table.userId, ctx.userId)).returning({ id: table.id });
      removed[name] = rows.length;
    };
    // Fichiers des documents de candidature (CV personnalisés, lettres) ; ceux du CV master sont conservés.
    const docFiles = await tx.delete(t.files).where(and(eq(t.files.userId, ctx.userId), sql`${t.files.kind} in ('cv_docx', 'cv_pdf', 'cv_preview', 'letter_docx', 'letter_pdf', 'letter_preview') and ${t.files.refId} not in (select id from cv_versions where user_id = ${ctx.userId} and kind = 'master')`)).returning({ id: t.files.id });
    removed.documentFiles = docFiles.length;
    for (const [name, table, extra] of [
      ['emails', t.emails],
      ['drafts', t.drafts],
      ['interviews', t.interviews],
      ['contacts', t.contacts],
      ['letters', t.letters],
      ['cvVersions', t.cvVersions, sql`${t.cvVersions.kind} <> 'master'`],
      ['jobs', t.jobs],
      ['feedback', t.feedback],
    ] as [string, unknown, ReturnType<typeof and>?][]) await wipe(name, table, extra);
    await tx.delete(t.sourceRuns).where(eq(t.sourceRuns.userId, ctx.userId));
    await tx.delete(t.actionItems).where(and(eq(t.actionItems.userId, ctx.userId), sql`${t.actionItems.type} not like 'setup.%'`));
    await tx.delete(t.tasks).where(eq(t.tasks.userId, ctx.userId));
    await tx.delete(t.notifications).where(eq(t.notifications.userId, ctx.userId));
    if (scope === 'all') {
      for (const [name, table] of [['sources', t.sources], ['companies', t.companies], ['searchProfiles', t.searchProfiles], ['profileDiffs', t.profileDiffs], ['linkedinSnapshots', t.linkedinSnapshots], ['templates', t.templates], ['cvMasters', t.cvVersions], ['atsPrompts', t.atsPrompts], ['qaAnswers', t.qaAnswers], ['profileFacts', t.profileFacts], ['actionItems', t.actionItems]] as [string, unknown][]) await wipe(name, table);
      removed.files = (await tx.delete(t.files).where(eq(t.files.userId, ctx.userId)).returning({ id: t.files.id })).length;
      removed.secrets = (await tx.delete(t.secrets).where(eq(t.secrets.userId, ctx.userId)).returning({ key: t.secrets.key })).length;
      await tx.delete(t.settings).where(eq(t.settings.userId, ctx.userId));
      await tx.delete(t.llmCalls).where(eq(t.llmCalls.userId, ctx.userId));
      await tx.delete(t.scheduleState).where(eq(t.scheduleState.scope, ctx.userId));
    }
  });
  await logActivity(ctx.db, { userId: ctx.userId, actor: 'user', action: 'data.deleted', level: 'warn', summary: scope === 'all' ? 'Toutes les données ont été effacées (compte conservé)' : 'Offres, candidatures et emails effacés (profil conservé)', data: removed });
  return removed;
}
