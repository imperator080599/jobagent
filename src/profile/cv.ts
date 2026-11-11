// Versions de CV. Règles structurantes :
//  - le CV master est la seule source de vérité ; il n'est jamais modifié en place ;
//  - toute évolution passe par un brouillon, puis une validation explicite de l'utilisateur ;
//  - chaque version validée est conservée définitivement (historique complet).
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { UserContext } from '../core/context.js';
import type { Db } from '../db/client.js';
import { cvVersions } from '../db/schema.js';
import { newId } from '../db/ids.js';
import { logActivity } from '../core/activity.js';
import { badRequest, conflict, notFound } from '../core/errors.js';
import { saveFile } from '../core/files.js';
import { raiseAction, resolveAction } from '../core/inbox.js';
import { unblockByReason } from '../core/queue.js';
import { detectLanguage } from '../core/text.js';
import { type CvData, CvData as CvDataSchema, assignIds, cvToText } from '../shared/cv.js';
import { structureCv } from './cv-import.js';
import { extractDocumentText } from './extract.js';
import { setFact } from './facts.js';

export type CvVersion = typeof cvVersions.$inferSelect;

type MasterHook = (ctx: UserContext, master: CvVersion) => Promise<void>;
const masterApprovedHooks: MasterHook[] = [];
/** Les autres modules (documents, pipeline) réagissent à la validation d'un nouveau CV master. */
export function onMasterApproved(hook: MasterHook) {
  masterApprovedHooks.push(hook);
}

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

async function nextVersion(db: Db, userId: string, kind: CvVersion['kind'], language: string): Promise<number> {
  const [row] = await db
    .select({ v: sql<number>`coalesce(max(${cvVersions.version}), 0)::int` })
    .from(cvVersions)
    .where(and(eq(cvVersions.userId, userId), eq(cvVersions.kind, kind), eq(cvVersions.language, language)));
  return (row?.v ?? 0) + 1;
}

export async function getCv(db: Db, userId: string, id: string): Promise<CvVersion> {
  const [row] = await db.select().from(cvVersions).where(and(eq(cvVersions.id, id), eq(cvVersions.userId, userId)));
  if (!row) throw notFound('Version de CV introuvable.');
  return row;
}

export async function listCvVersions(db: Db, userId: string, opts: { kinds?: CvVersion['kind'][]; jobId?: string } = {}) {
  const conds = [eq(cvVersions.userId, userId)];
  if (opts.kinds?.length) conds.push(inArray(cvVersions.kind, opts.kinds));
  if (opts.jobId) conds.push(eq(cvVersions.jobId, opts.jobId));
  return db
    .select({
      id: cvVersions.id,
      kind: cvVersions.kind,
      label: cvVersions.label,
      language: cvVersions.language,
      version: cvVersions.version,
      status: cvVersions.status,
      isCurrent: cvVersions.isCurrent,
      source: cvVersions.source,
      jobId: cvVersions.jobId,
      parentId: cvVersions.parentId,
      changeSummary: cvVersions.changeSummary,
      createdAt: cvVersions.createdAt,
      approvedAt: cvVersions.approvedAt,
      sourceFileId: cvVersions.sourceFileId,
      pdfFileId: cvVersions.pdfFileId,
      docxFileId: cvVersions.docxFileId,
    })
    .from(cvVersions)
    .where(and(...conds))
    .orderBy(desc(cvVersions.createdAt));
}

/** CV master courant. À défaut de master dans la langue demandée, renvoie le master courant le plus récent. */
export async function getCurrentMaster(db: Db, userId: string, language?: string): Promise<CvVersion | null> {
  const rows = await db
    .select()
    .from(cvVersions)
    .where(and(eq(cvVersions.userId, userId), eq(cvVersions.kind, 'master'), eq(cvVersions.isCurrent, true)))
    .orderBy(desc(cvVersions.approvedAt));
  if (!rows.length) return null;
  return rows.find((r) => r.language === language) ?? rows[0]!;
}

export async function listCurrentMasters(db: Db, userId: string): Promise<CvVersion[]> {
  return db
    .select()
    .from(cvVersions)
    .where(and(eq(cvVersions.userId, userId), eq(cvVersions.kind, 'master'), eq(cvVersions.isCurrent, true)))
    .orderBy(desc(cvVersions.approvedAt));
}

export interface ImportResult {
  cv: CvVersion;
  method: 'llm' | 'rules';
  warnings: string[];
}

/** Importe un CV (PDF, DOCX ou texte) et crée un brouillon de master à relire. Le master courant n'est pas touché. */
export async function importCv(ctx: UserContext, file: { filename: string; mime: string; data: Uint8Array }): Promise<ImportResult> {
  if (file.data.byteLength === 0) throw badRequest('Le fichier est vide.');
  if (file.data.byteLength > MAX_UPLOAD_BYTES) throw badRequest('Fichier trop volumineux (8 Mo maximum).');
  const doc = await extractDocumentText(file);
  if (doc.text.length < 80) throw badRequest(doc.warnings[0] ?? 'Aucun texte exploitable dans ce document.');
  const structured = await structureCv(ctx, { text: doc.text, marked: doc.marked, pdf: doc.kind === 'pdf' ? file.data : undefined });
  const language = structured.cv.language || detectLanguage(doc.text) || 'fr';
  const data = assignIds({ ...structured.cv, language });
  const fileId = await saveFile(ctx.db, { userId: ctx.userId, kind: 'cv_source', filename: file.filename, mime: file.mime || 'application/octet-stream', data: file.data });
  const id = newId('cv');
  const [row] = await ctx.db
    .insert(cvVersions)
    .values({
      id,
      userId: ctx.userId,
      kind: 'master',
      label: file.filename,
      language,
      version: await nextVersion(ctx.db, ctx.userId, 'master', language),
      data,
      source: 'upload',
      status: 'draft',
      isCurrent: false,
      sourceFileId: fileId,
      checks: { method: structured.method, grounding: structured.warnings, extraction: doc.warnings, pages: doc.pages, sourceTextLength: doc.text.length },
      createdBy: 'user',
    })
    .returning();
  const warnings = [...doc.warnings];
  if (structured.method === 'rules') warnings.push("Analyse effectuée sans IA (aucune clé d'API configurée) : relisez attentivement la structure proposée.");
  if (structured.warnings.length) warnings.push(`${structured.warnings.length} élément(s) à vérifier : leur texte ne correspond pas exactement au document importé.`);
  await raiseAction(ctx.db, { userId: ctx.userId, type: 'cv.master.review', title: 'Relire et valider votre CV master', body: { cvId: id, filename: file.filename, warnings }, priority: 95, dedupKey: `cv.master.review:${id}` });
  await logActivity(ctx.db, { userId: ctx.userId, actor: 'user', action: 'cv.imported', entityType: 'cv', entityId: id, summary: `CV importé : ${file.filename}`, data: { method: structured.method, pages: doc.pages } });
  return { cv: row!, method: structured.method, warnings };
}

/** Modifie un brouillon. Une version validée est immuable. */
export async function updateCvDraft(ctx: UserContext, id: string, patch: { data?: unknown; label?: string }): Promise<CvVersion> {
  const current = await getCv(ctx.db, ctx.userId, id);
  if (current.status !== 'draft') throw conflict('Cette version est validée et ne peut plus être modifiée. Créez une nouvelle version.');
  const data = patch.data !== undefined ? assignIds(CvDataSchema.parse(patch.data)) : current.data;
  const [row] = await ctx.db
    .update(cvVersions)
    .set({ data, label: patch.label ?? current.label, language: data.language })
    .where(eq(cvVersions.id, id))
    .returning();
  return row!;
}

/** Crée un brouillon à partir d'une version existante (pour corriger ou faire évoluer le master). */
export async function forkCv(ctx: UserContext, baseId: string, opts: { data?: CvData; source?: CvVersion['source']; changeSummary?: string; createdBy?: string } = {}): Promise<CvVersion> {
  const base = await getCv(ctx.db, ctx.userId, baseId);
  const data = assignIds(opts.data ?? base.data);
  const [row] = await ctx.db
    .insert(cvVersions)
    .values({
      id: newId('cv'),
      userId: ctx.userId,
      kind: base.kind,
      label: base.label,
      language: data.language,
      version: await nextVersion(ctx.db, ctx.userId, base.kind, data.language),
      data,
      source: opts.source ?? 'manual',
      parentId: base.id,
      jobId: base.jobId,
      status: 'draft',
      changeSummary: opts.changeSummary ?? '',
      sourceFileId: base.sourceFileId,
      createdBy: opts.createdBy ?? 'user',
    })
    .returning();
  return row!;
}

export async function deleteCvDraft(ctx: UserContext, id: string): Promise<void> {
  const current = await getCv(ctx.db, ctx.userId, id);
  if (current.status !== 'draft') throw conflict('Seul un brouillon peut être supprimé : les versions validées sont conservées.');
  await ctx.db.delete(cvVersions).where(eq(cvVersions.id, id));
  await resolveAction(ctx.db, ctx.userId, { dedupKey: `cv.master.review:${id}` }, { deleted: true }, 'dismissed');
}

function splitName(fullName: string): { first: string; last: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { first: parts[0] ?? '', last: '' };
  // Usage courant : le nom de famille est écrit en capitales.
  const isUpper = (p: string) => p.length > 1 && p === p.toUpperCase() && /\p{L}/u.test(p);
  const upper = parts.filter(isUpper);
  if (upper.length && upper.length < parts.length) return { first: parts.filter((p) => !isUpper(p)).join(' '), last: upper.join(' ') };
  return { first: parts[0]!, last: parts.slice(1).join(' ') };
}

/** Alimente le référentiel depuis le CV master validé (sans jamais écraser une valeur validée par l'utilisateur). */
export async function syncFactsFromCv(ctx: UserContext, cv: CvVersion): Promise<void> {
  const d = cv.data;
  const ref = `cv:${cv.id}`;
  const set = (key: string, value: unknown) => setFact(ctx.db, ctx.userId, { key, value, source: 'cv_master', sourceRef: ref, actor: 'system' });
  const name = splitName(d.identity.fullName);
  await set('contact.first_name', name.first);
  await set('contact.last_name', name.last);
  await set('contact.email', d.identity.email);
  await set('contact.phone', d.identity.phone);
  await set('contact.linkedin_url', d.identity.linkedin);
  await set('contact.website', d.identity.website);
  const current = d.experiences.find((e) => e.end === 'present') ?? d.experiences[0];
  if (current) {
    await set('background.current_title', current.title);
    await set('background.current_employer', current.company);
  }
  const edu = d.education[0];
  if (edu) {
    await set('background.highest_degree', [edu.degree, edu.field].filter(Boolean).join(', '));
    await set('background.school', edu.school);
    if (/^\d{4}/.test(edu.end)) await set('background.graduation_year', edu.end.slice(0, 4));
  }
  if (d.languages.length) await set('background.languages', d.languages.map((l) => [l.language, l.level, l.certification && `(${l.certification})`].filter(Boolean).join(' — ')));
}

/** Valide un brouillon. Pour un master : il devient la référence de sa langue, l'ancien est conservé dans l'historique. */
export async function approveCv(ctx: UserContext, id: string): Promise<CvVersion> {
  const draft = await getCv(ctx.db, ctx.userId, id);
  if (draft.status === 'approved') return draft;
  if (draft.status !== 'draft') throw conflict('Cette version ne peut pas être validée.');
  if (draft.kind === 'master') {
    if (!draft.data.identity.fullName.trim()) throw badRequest('Le nom est obligatoire.');
    if (draft.data.experiences.length === 0 && draft.data.education.length === 0) throw badRequest('Le CV ne contient ni expérience ni formation : complétez-le avant de le valider.');
  }
  const now = new Date();
  const approved = await ctx.db.transaction(async (tx) => {
    if (draft.kind === 'master') {
      await tx
        .update(cvVersions)
        .set({ isCurrent: false })
        .where(and(eq(cvVersions.userId, ctx.userId), eq(cvVersions.kind, 'master'), eq(cvVersions.language, draft.language), eq(cvVersions.isCurrent, true)));
    }
    const [row] = await tx
      .update(cvVersions)
      .set({ status: 'approved', approvedAt: now, isCurrent: draft.kind === 'master' })
      .where(eq(cvVersions.id, id))
      .returning();
    return row!;
  });
  await logActivity(ctx.db, {
    userId: ctx.userId,
    actor: 'user',
    action: 'cv.approved',
    entityType: 'cv',
    entityId: id,
    summary: draft.kind === 'master' ? `CV master validé (version ${approved.version}, ${approved.language.toUpperCase()})` : 'CV validé',
  });
  await resolveAction(ctx.db, ctx.userId, { dedupKey: `cv.master.review:${id}` }, { approved: true });
  if (draft.kind === 'master') {
    await resolveAction(ctx.db, ctx.userId, { dedupKey: 'setup.cv_master' }, { cvId: id });
    await syncFactsFromCv(ctx, approved);
    await unblockByReason(ctx.db, ctx.userId, ['cv_master_missing']);
    // Le template de CV suit le master : constitué ou mis à jour dès la validation.
    for (const hook of masterApprovedHooks) await hook(ctx, approved);
  }
  return approved;
}

// ── Comparaison de versions ──

export interface CvChange {
  kind: 'added' | 'removed' | 'changed';
  section: string;
  where: string;
  before?: string;
  after?: string;
}

/** Différences lisibles entre deux versions (affichage de l'historique et relecture des CV personnalisés). */
export function diffCv(before: CvData, after: CvData): CvChange[] {
  const out: CvChange[] = [];
  const field = (section: string, where: string, a: string, b: string) => {
    if ((a ?? '') === (b ?? '')) return;
    if (!a) out.push({ kind: 'added', section, where, after: b });
    else if (!b) out.push({ kind: 'removed', section, where, before: a });
    else out.push({ kind: 'changed', section, where, before: a, after: b });
  };
  const idn = ['fullName', 'headline', 'email', 'phone', 'location', 'linkedin', 'website'] as const;
  for (const k of idn) field('Identité', k, before.identity[k] ?? '', after.identity[k] ?? '');
  field('Profil', 'Résumé', before.summary, after.summary);

  const listDiff = <T extends { id: string }>(section: string, a: T[], b: T[], label: (x: T) => string, inner: (x: T, y: T, where: string) => void) => {
    const bm = new Map(b.map((x) => [x.id, x]));
    const am = new Map(a.map((x) => [x.id, x]));
    for (const x of a) {
      const y = bm.get(x.id);
      if (!y) out.push({ kind: 'removed', section, where: label(x), before: label(x) });
      else inner(x, y, label(y));
    }
    for (const y of b) if (!am.has(y.id)) out.push({ kind: 'added', section, where: label(y), after: label(y) });
  };
  const bullets = (section: string, where: string, a: { id: string; text: string }[], b: { id: string; text: string }[]) => {
    const bm = new Map(b.map((x) => [x.id, x.text]));
    const am = new Map(a.map((x) => [x.id, x.text]));
    for (const x of a) {
      const y = bm.get(x.id);
      if (y === undefined) out.push({ kind: 'removed', section, where, before: x.text });
      else if (y !== x.text) out.push({ kind: 'changed', section, where, before: x.text, after: y });
    }
    for (const y of b) if (!am.has(y.id)) out.push({ kind: 'added', section, where, after: y.text });
  };
  listDiff('Expériences', before.experiences, after.experiences, (e) => `${e.title} — ${e.company}`, (x, y, where) => {
    field('Expériences', `${where} · entreprise`, x.company, y.company);
    field('Expériences', `${where} · intitulé`, x.title, y.title);
    field('Expériences', `${where} · lieu`, x.location, y.location);
    field('Expériences', `${where} · début`, x.start, y.start);
    field('Expériences', `${where} · fin`, x.end, y.end);
    field('Expériences', `${where} · description`, x.summary, y.summary);
    bullets('Expériences', where, x.bullets, y.bullets);
  });
  listDiff('Formation', before.education, after.education, (e) => `${e.degree} — ${e.school}`, (x, y, where) => {
    field('Formation', `${where} · école`, x.school, y.school);
    field('Formation', `${where} · diplôme`, x.degree, y.degree);
    field('Formation', `${where} · spécialité`, x.field, y.field);
    field('Formation', `${where} · début`, x.start, y.start);
    field('Formation', `${where} · fin`, x.end, y.end);
    bullets('Formation', where, x.details, y.details);
  });
  listDiff('Compétences', before.skills, after.skills, (s) => s.label || 'Compétences', (x, y, where) => field('Compétences', where, x.items.join(', '), y.items.join(', ')));
  listDiff('Langues', before.languages, after.languages, (l) => l.language, (x, y, where) => field('Langues', where, `${x.level} ${x.certification}`.trim(), `${y.level} ${y.certification}`.trim()));
  listDiff('Certifications', before.certifications, after.certifications, (c) => c.name, (x, y, where) => field('Certifications', where, `${x.issuer} ${x.date}`.trim(), `${y.issuer} ${y.date}`.trim()));
  listDiff('Autres rubriques', before.extras, after.extras, (x) => x.title, (x, y, where) => bullets('Autres rubriques', where, x.items, y.items));
  return out;
}

export { cvToText };
