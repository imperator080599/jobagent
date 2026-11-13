// Gestion des templates de documents. Chaque import crée une nouvelle version ;
// l'original fourni par l'utilisateur est conservé tel quel, et aucune version
// n'est supprimée (on peut revenir à une version antérieure sans intervention technique).
import { and, desc, eq } from 'drizzle-orm';
import type { UserContext } from '../core/context.js';
import type { Db } from '../db/client.js';
import { cvVersions, templates } from '../db/schema.js';
import { newId } from '../db/ids.js';
import { logActivity } from '../core/activity.js';
import { badRequest, notFound } from '../core/errors.js';
import { getFile, saveFile } from '../core/files.js';
import { raiseAction, resolveAction } from '../core/inbox.js';
import { unblockByReason } from '../core/queue.js';
import type { CvVersion } from '../profile/cv.js';
import { CLASSIC_BUILDER_VERSION, DEFAULT_CLASSIC_STYLE, FIT_STEPS, buildClassicCv } from './classic-cv.js';
import { docxToPdf, documentCapabilities, pdfToPng, toDocx } from './convert.js';
import { type CvTemplateProfile, alignCvTemplate, renderCv } from './cv-template.js';
import { type DocxPackage, readDocx, writeDocx } from './docx.js';
import { type LetterTemplateProfile, analyzeLetterTemplate } from './letter-template.js';
import { measurePdf } from './qa.js';

export type Template = typeof templates.$inferSelect;
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function sniffTemplateFormat(filename: string, data: Uint8Array): 'docx' | 'rtf' | 'doc' | 'odt' | null {
  const head = Buffer.from(data.subarray(0, 8));
  if (head.toString('latin1').startsWith('{\\rtf')) return 'rtf';
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) return 'doc';
  if (head[0] === 0x50 && head[1] === 0x4b) return /\.odt$/i.test(filename) ? 'odt' : 'docx';
  return null;
}

export async function listTemplates(db: Db, userId: string, kind?: Template['kind']) {
  const conds = [eq(templates.userId, userId)];
  if (kind) conds.push(eq(templates.kind, kind));
  return db.select().from(templates).where(and(...conds)).orderBy(desc(templates.createdAt));
}

export async function getTemplate(db: Db, userId: string, id: string): Promise<Template> {
  const [row] = await db.select().from(templates).where(and(eq(templates.id, id), eq(templates.userId, userId)));
  if (!row) throw notFound('Template introuvable.');
  return row;
}

/** Template actif. Pour un CV : celui de la langue demandée ; pour une lettre : le template actif, quelle que soit sa langue. */
export async function getActiveTemplate(db: Db, userId: string, kind: Template['kind'], language?: string): Promise<Template | null> {
  const rows = await db.select().from(templates).where(and(eq(templates.userId, userId), eq(templates.kind, kind), eq(templates.isActive, true))).orderBy(desc(templates.createdAt));
  if (kind === 'cv') return rows.find((r) => r.language === language) ?? null;
  return rows.find((r) => r.language === language) ?? rows[0] ?? null;
}

export async function loadTemplateDocx(db: Db, t: Template): Promise<DocxPackage> {
  const file = await getFile(db, t.userId, t.docxFileId);
  if (!file) throw new Error('Le fichier du template est introuvable.');
  return readDocx(file.data);
}

async function store(ctx: UserContext, input: { kind: Template['kind']; name: string; language: string; origin: Template['origin']; source: { filename: string; mime: string; data: Uint8Array }; docx: Uint8Array; profile: CvTemplateProfile | LetterTemplateProfile; masterCvId?: string; notes: string[] }): Promise<Template> {
  const sourceFileId = await saveFile(ctx.db, { userId: ctx.userId, kind: 'template_source', filename: input.source.filename, mime: input.source.mime, data: input.source.data });
  const docxFileId = input.source.data === input.docx ? sourceFileId : await saveFile(ctx.db, { userId: ctx.userId, kind: 'template_docx', filename: input.name.replace(/\.[a-z0-9]+$/i, '') + '.docx', mime: DOCX_MIME, data: input.docx });
  // Rendu du template lui-même : aperçu pour l'utilisateur et référence du contrôle qualité.
  let baseline: Record<string, unknown> | null = null;
  let previewFileId: string | null = null;
  let pdfFileId: string | null = null;
  const caps = await documentCapabilities();
  if (caps.office) {
    try {
      const pdf = await docxToPdf(input.docx);
      const m = await measurePdf(pdf);
      baseline = { ...m, text: undefined };
      pdfFileId = await saveFile(ctx.db, { userId: ctx.userId, kind: 'template_pdf', filename: 'template.pdf', mime: 'application/pdf', data: pdf });
      if (caps.poppler) {
        const [png] = await pdfToPng(pdf, { dpi: 70, maxPages: 1 });
        if (png) previewFileId = await saveFile(ctx.db, { userId: ctx.userId, kind: 'template_preview', filename: 'template.png', mime: 'image/png', data: png });
      }
    } catch (err) {
      input.notes.push(`Aperçu du template indisponible : ${err instanceof Error ? err.message : String(err)}`);
    }
  } else input.notes.push("Aperçu et rendu PDF indisponibles sur cette machine : ils seront produits par le worker de documents.");

  return ctx.db.transaction(async (tx) => {
    const previous = await tx.select({ v: templates.version }).from(templates).where(and(eq(templates.userId, ctx.userId), eq(templates.kind, input.kind))).orderBy(desc(templates.version)).limit(1);
    const sameSlot = input.kind === 'cv' ? and(eq(templates.userId, ctx.userId), eq(templates.kind, 'cv'), eq(templates.language, input.language), eq(templates.isActive, true)) : and(eq(templates.userId, ctx.userId), eq(templates.kind, 'letter'), eq(templates.isActive, true));
    await tx.update(templates).set({ isActive: false }).where(sameSlot);
    const [row] = await tx
      .insert(templates)
      .values({
        id: newId('tpl'),
        userId: ctx.userId,
        kind: input.kind,
        name: input.name,
        language: input.language,
        version: (previous[0]?.v ?? 0) + 1,
        isActive: true,
        origin: input.origin,
        sourceFileId,
        docxFileId,
        previewFileId,
        pdfFileId,
        profile: input.profile as unknown as Record<string, unknown>,
        baseline,
        masterCvId: input.masterCvId ?? null,
        notes: input.notes,
      })
      .returning();
    return row!;
  });
}

async function toWorkingDocx(file: { filename: string; data: Uint8Array }): Promise<Uint8Array> {
  const format = sniffTemplateFormat(file.filename, file.data);
  if (!format) throw badRequest('Format de template non pris en charge. Importez un fichier Word (.docx), RTF, DOC ou ODT.');
  if (format === 'docx') return file.data;
  return toDocx(file.data, format);
}

/** Importe un template de lettre (Word ou RTF à zones entre crochets). */
export async function importLetterTemplate(ctx: UserContext, file: { filename: string; mime: string; data: Uint8Array }): Promise<Template> {
  const docx = await toWorkingDocx(file);
  const pkg = readDocx(docx);
  const profile = analyzeLetterTemplate(pkg);
  const notes: string[] = [];
  if (!profile.sections.length) throw badRequest("Aucune zone de rédaction n'a été reconnue dans ce modèle. Les zones à remplir doivent être écrites entre crochets, par exemple [Introduction].");
  if (profile.unknownPlaceholders.length) notes.push(`Zones non reconnues, laissées telles quelles : ${profile.unknownPlaceholders.map((p) => `[${p}]`).join(', ')}`);
  if (profile.vendorFooters.length) notes.push('Le pied de page du fournisseur du modèle (mention publicitaire ou copyright) est retiré des lettres générées.');
  const t = await store(ctx, { kind: 'letter', name: file.filename, language: profile.language, origin: 'upload', source: file, docx, profile, notes });
  await logActivity(ctx.db, { userId: ctx.userId, actor: 'user', action: 'template.imported', entityType: 'template', entityId: t.id, summary: `Template de lettre importé : ${file.filename} (version ${t.version})` });
  // Les candidatures qui attendaient un modèle de lettre reprennent.
  await resolveAction(ctx.db, ctx.userId, { dedupKey: 'setup.letter_template' }, { templateId: t.id });
  await unblockByReason(ctx.db, ctx.userId, ['letter_template_missing']);
  return t;
}

/**
 * Importe un template de CV : le document Word du CV tel que l'utilisateur l'utilise.
 * Il doit contenir le contenu du CV master, auquel chaque paragraphe est rattaché.
 */
export async function importCvTemplate(ctx: UserContext, file: { filename: string; mime: string; data: Uint8Array }, master: CvVersion): Promise<Template> {
  const docx = await toWorkingDocx(file);
  const pkg = readDocx(docx);
  const profile = alignCvTemplate(pkg, master.data);
  const total = Object.keys(profile.elements).length + profile.unmatched.length;
  const ratio = total ? Object.keys(profile.elements).length / total : 0;
  if (ratio < 0.7) {
    throw badRequest(
      `Ce document ne correspond pas à votre CV master (${Math.round(ratio * 100)} % du contenu retrouvé). Le template de CV est votre CV au format Word : importez le fichier Word dont votre CV master est issu, ou importez d'abord ce document comme nouveau CV master.`,
    );
  }
  const notes = profile.unmatched.length ? [`${profile.unmatched.length} élément(s) du CV master introuvable(s) dans ce document : ils ne pourront pas être modifiés dans les CV personnalisés.`] : [];
  const t = await store(ctx, { kind: 'cv', name: file.filename, language: master.language, origin: 'upload', source: file, docx, profile, masterCvId: master.id, notes });
  await resolveAction(ctx.db, ctx.userId, { dedupKey: `template.cv.outdated:${master.language}` }, { templateId: t.id });
  await logActivity(ctx.db, { userId: ctx.userId, actor: 'user', action: 'template.imported', entityType: 'template', entityId: t.id, summary: `Template de CV importé : ${file.filename} (version ${t.version})` });
  return t;
}

/** Constitue un template Word à partir du CV master quand aucun fichier Word n'a été fourni. */
async function buildCvTemplate(ctx: UserContext, master: CvVersion, origin: 'built' | 'evolved', note: string): Promise<Template> {
  // Le document constitué doit tenir sur la pagination du CV d'origine : les réglages sont resserrés par paliers jusqu'à y parvenir.
  const target = Number((master.checks as { pages?: number } | null)?.pages) || 0;
  const caps = await documentCapabilities();
  let docx = await buildClassicCv(master.data);
  const notes = [note];
  if (target > 0 && caps.office) {
    let fitted = false;
    for (const [i, step] of FIT_STEPS.entries()) {
      const candidate = i === 0 ? docx : await buildClassicCv(master.data, { ...DEFAULT_CLASSIC_STYLE, ...step });
      const pages = (await measurePdf(await docxToPdf(candidate))).pages;
      if (pages <= target) {
        docx = candidate;
        fitted = true;
        if (i > 0) notes.push(step.size ? `Mise en page resserrée (marges, espacements, corps ${step.size} pt) pour tenir sur ${target} page(s), comme votre CV d'origine.` : `Marges et espacements légèrement resserrés pour tenir sur ${target} page(s), comme votre CV d'origine.`);
        break;
      }
    }
    if (!fitted) notes.push(`Ce document ne tient pas sur ${target} page(s) comme votre CV d'origine : importez votre CV au format Word pour retrouver sa mise en page exacte.`);
  }
  const profile = { ...alignCvTemplate(readDocx(docx), master.data), builder: CLASSIC_BUILDER_VERSION };
  return store(ctx, { kind: 'cv', name: `CV ${master.data.identity.fullName} (${master.language.toUpperCase()}).docx`, language: master.language, origin, source: { filename: 'cv-template.docx', mime: DOCX_MIME, data: docx }, docx, profile, masterCvId: master.id, notes });
}

/**
 * Garantit un template de CV aligné sur le master donné.
 *  - Aucun template : si le master provient d'un fichier Word, ce fichier devient le template ;
 *    sinon un document Word au format classique est constitué à partir du CV.
 *  - Template aligné sur un master antérieur : il est mis à jour en y reportant les changements.
 */
export async function ensureCvTemplate(ctx: UserContext, master: CvVersion): Promise<Template> {
  const active = await getActiveTemplate(ctx.db, ctx.userId, 'cv', master.language);
  if (active?.masterCvId === master.id) {
    // Un document constitué par une version antérieure du générateur est reconstruit ; un fichier fourni par l'utilisateur n'est jamais touché.
    const meta = active.profile as { builder?: number; fromUpload?: boolean };
    const stale = active.origin !== 'upload' && !meta.fromUpload && meta.builder !== CLASSIC_BUILDER_VERSION;
    if (!stale) return active;
    return buildCvTemplate(ctx, master, active.origin === 'built' ? 'built' : 'evolved', "Document Word constitué à partir de votre CV, faute de fichier Word d'origine. Importez votre CV au format Word pour que vos documents reprennent exactement votre mise en page.");
  }

  if (!active) {
    const source = master.sourceFileId ? await getFile(ctx.db, ctx.userId, master.sourceFileId) : null;
    if (source && sniffTemplateFormat(source.filename, source.data) === 'docx') {
      try {
        return await importCvTemplate(ctx, { filename: source.filename, mime: source.mime, data: source.data }, master);
      } catch {
        /* le fichier Word ne s'aligne pas sur le master corrigé : on constitue un document de travail */
      }
    }
    return buildCvTemplate(ctx, master, 'built', "Document Word constitué à partir de votre CV, faute de fichier Word d'origine. Importez votre CV au format Word pour que vos documents reprennent exactement votre mise en page.");
  }

  // Le master a évolué : on reporte ses changements dans une copie du template existant.
  const [previousMaster] = active.masterCvId ? await ctx.db.select().from(cvVersions).where(and(eq(cvVersions.id, active.masterCvId), eq(cvVersions.userId, ctx.userId))) : [];
  if (previousMaster) {
    const pkg = await loadTemplateDocx(ctx.db, active);
    const rendered = renderCv(pkg, active.profile as unknown as CvTemplateProfile, previousMaster.data, master.data);
    const docx = writeDocx(rendered.pkg);
    // La filiation est conservée : un template issu du fichier Word de l'utilisateur ne sera jamais remplacé par un document reconstitué.
    const lineage = active.profile as { builder?: number; fromUpload?: boolean };
    const profile = { ...alignCvTemplate(readDocx(docx), master.data), builder: lineage.builder, fromUpload: active.origin === 'upload' || Boolean(lineage.fromUpload) };
    if (!rendered.problems.length && !profile.unmatched.length) {
      return store(ctx, { kind: 'cv', name: active.name, language: master.language, origin: 'evolved', source: { filename: active.name, mime: DOCX_MIME, data: docx }, docx, profile, masterCvId: master.id, notes: ['Template mis à jour avec la nouvelle version du CV master.'] });
    }
  }
  if (active.origin !== 'upload') return buildCvTemplate(ctx, master, 'evolved', 'Document Word reconstitué à partir de la nouvelle version du CV master.');

  // Template fourni par l'utilisateur, impossible à mettre à jour seul (nouvelle expérience, par exemple) : on le signale.
  await raiseAction(ctx.db, {
    userId: ctx.userId,
    type: 'system.alert',
    title: 'Votre template de CV doit être mis à jour',
    body: { text: "Votre CV master contient des éléments absents de votre template Word (nouvelle expérience ou formation). Importez la version Word à jour de votre CV dans « Mes documents ». En attendant, un document au format classique est utilisé.", link: '/profil/cv' },
    priority: 70,
    dedupKey: `template.cv.outdated:${master.language}`,
    reopen: true,
  });
  return buildCvTemplate(ctx, master, 'evolved', "Document de remplacement : votre template Word ne contient pas les dernières évolutions du CV master.");
}

export async function activateTemplate(ctx: UserContext, id: string): Promise<Template> {
  const t = await getTemplate(ctx.db, ctx.userId, id);
  const row = await ctx.db.transaction(async (tx) => {
    const slot = t.kind === 'cv' ? and(eq(templates.userId, ctx.userId), eq(templates.kind, 'cv'), eq(templates.language, t.language), eq(templates.isActive, true)) : and(eq(templates.userId, ctx.userId), eq(templates.kind, 'letter'), eq(templates.isActive, true));
    await tx.update(templates).set({ isActive: false }).where(slot);
    const [r] = await tx.update(templates).set({ isActive: true }).where(eq(templates.id, id)).returning();
    return r!;
  });
  await logActivity(ctx.db, { userId: ctx.userId, actor: 'user', action: 'template.activated', entityType: 'template', entityId: id, summary: `Template réactivé : ${t.name} (version ${t.version})` });
  return row;
}
