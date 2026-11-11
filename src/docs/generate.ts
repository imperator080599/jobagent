// Production des documents de candidature : copie du template remplie (DOCX),
// conversion en PDF, puis contrôle du rendu réel. Un document n'est déclaré prêt
// que si le PDF a été rouvert et vérifié.
import { and, eq } from 'drizzle-orm';
import type { UserContext } from '../core/context.js';
import { ConfigError } from '../core/errors.js';
import { saveFile } from '../core/files.js';
import { cvVersions, letters } from '../db/schema.js';
import { type CvVersion, getCv } from '../profile/cv.js';
import { type CvData, stripMarkup } from '../shared/cv.js';
import { docxToPdf, documentCapabilities, pdfToPng } from './convert.js';
import { type CvTemplateProfile, renderCv } from './cv-template.js';
import { writeDocx } from './docx.js';
import { type LetterContent, type LetterTemplateProfile, renderLetter } from './letter-template.js';
import { type DocCheck, type PageMetrics, checkRenderedDocument } from './qa.js';
import { ensureCvTemplate, getActiveTemplate, loadTemplateDocx } from './templates.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface RenderOutcome {
  docxFileId: string;
  pdfFileId: string | null;
  previewFileId: string | null;
  templateId: string;
  /** null tant que le PDF n'a pas pu être produit (rendu confié au worker de documents). */
  ok: boolean | null;
  checks: DocCheck[];
  problems: string[];
  pages: number | null;
}

function safeName(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 _.-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function cvExpectedTexts(cv: CvData): string[] {
  const out = [cv.identity.fullName, cv.summary ?? ''];
  for (const e of cv.experiences) out.push(e.company, e.title, ...e.bullets.map((b) => b.text));
  for (const e of cv.education) out.push(e.school, e.degree, ...e.details.map((b) => b.text));
  for (const g of cv.skills) out.push(...g.items);
  for (const x of cv.extras) out.push(...x.items.map((b) => b.text));
  return out.map(stripMarkup).filter((t) => t.trim().length > 3);
}

async function finish(ctx: UserContext, input: { docx: Uint8Array; baseName: string; kind: 'cv' | 'letter'; refId: string; expectedTexts: string[]; maxPages: number; templateFonts: string[]; baseline?: PageMetrics; page: { left: number; right: number; top: number; bottom: number } | null }) {
  const docxFileId = await saveFile(ctx.db, { userId: ctx.userId, kind: `${input.kind}_docx`, filename: `${input.baseName}.docx`, mime: DOCX_MIME, data: input.docx, refType: input.kind, refId: input.refId });
  const caps = await documentCapabilities();
  if (!caps.office) return { docxFileId, pdfFileId: null, previewFileId: null, ok: null, checks: [] as DocCheck[], pages: null };
  const pdf = await docxToPdf(input.docx);
  const qa = await checkRenderedDocument({ pdf, expectedTexts: input.expectedTexts, maxPages: input.maxPages, templateFonts: input.templateFonts, baseline: input.baseline, page: input.page });
  const pdfFileId = await saveFile(ctx.db, { userId: ctx.userId, kind: `${input.kind}_pdf`, filename: `${input.baseName}.pdf`, mime: 'application/pdf', data: pdf, refType: input.kind, refId: input.refId });
  let previewFileId: string | null = null;
  if (caps.poppler) {
    const [png] = await pdfToPng(pdf, { dpi: 70, maxPages: 1 });
    if (png) previewFileId = await saveFile(ctx.db, { userId: ctx.userId, kind: `${input.kind}_preview`, filename: `${input.baseName}.png`, mime: 'image/png', data: png, refType: input.kind, refId: input.refId });
  }
  return { docxFileId, pdfFileId, previewFileId, ok: qa.ok, checks: qa.checks, pages: qa.pages };
}

/** Master sur lequel s'appuie une version de CV (elle-même si c'est un master). */
async function masterOf(ctx: UserContext, cv: CvVersion): Promise<CvVersion> {
  if (cv.kind === 'master') return cv;
  if (!cv.parentId) throw new Error('Cette version de CV ne référence aucun CV master.');
  let current = await getCv(ctx.db, ctx.userId, cv.parentId);
  for (let i = 0; i < 5 && current.kind !== 'master' && current.parentId; i++) current = await getCv(ctx.db, ctx.userId, current.parentId);
  return current;
}

/** Génère le document (DOCX, puis PDF contrôlé) d'une version de CV, dans le template actif. */
export async function renderCvVersion(ctx: UserContext, cvId: string, opts: { label?: string } = {}): Promise<RenderOutcome> {
  const cv = await getCv(ctx.db, ctx.userId, cvId);
  const master = await masterOf(ctx, cv);
  const template = await ensureCvTemplate(ctx, master);
  const pkg = await loadTemplateDocx(ctx.db, template);
  const profile = template.profile as unknown as CvTemplateProfile;
  const rendered = renderCv(pkg, profile, master.data, cv.data);
  const baseline = (template.baseline as unknown as PageMetrics | null) ?? undefined;
  const baseName = safeName(`CV ${cv.data.identity.fullName}${opts.label ? ` - ${opts.label}` : ''}`);
  const out = await finish(ctx, { docx: writeDocx(rendered.pkg), baseName, kind: 'cv', refId: cv.id, expectedTexts: cvExpectedTexts(cv.data), maxPages: baseline?.pages ?? 1, templateFonts: profile.fonts, baseline, page: profile.page });
  const ok = out.ok === null ? null : out.ok && rendered.problems.length === 0;
  await ctx.db
    .update(cvVersions)
    .set({ docxFileId: out.docxFileId, pdfFileId: out.pdfFileId, checks: { ...(cv.checks ?? {}), render: { ok, checks: out.checks, problems: rendered.problems, pages: out.pages, templateId: template.id, templateVersion: template.version, previewFileId: out.previewFileId, at: ctx.now().toISOString() } } })
    .where(and(eq(cvVersions.id, cv.id), eq(cvVersions.userId, ctx.userId)));
  return { ...out, ok, templateId: template.id, problems: rendered.problems };
}

/** Génère le document d'une lettre dans le template de lettre actif. */
export async function renderLetterDocument(ctx: UserContext, letterId: string, content: LetterContent, opts: { label?: string; language?: string } = {}): Promise<RenderOutcome> {
  const template = await getActiveTemplate(ctx.db, ctx.userId, 'letter', opts.language);
  if (!template) throw new ConfigError('Aucun template de lettre n\'est importé (Profil → Mes documents).', 'letter_template_missing');
  const pkg = await loadTemplateDocx(ctx.db, template);
  const profile = template.profile as unknown as LetterTemplateProfile;
  const rendered = renderLetter(pkg, profile, content);
  const expected = [content.sender.name, content.salutation, ...Object.values(content.sections).flat(), content.closing].filter(Boolean);
  const baseName = safeName(`Lettre ${content.sender.name}${opts.label ? ` - ${opts.label}` : ''}`);
  const baseline = (template.baseline as unknown as PageMetrics | null) ?? undefined;
  const out = await finish(ctx, { docx: writeDocx(rendered), baseName, kind: 'letter', refId: letterId, expectedTexts: expected, maxPages: 1, templateFonts: profile.fonts, baseline: baseline ? { ...baseline, top: baseline.top } : undefined, page: profile.page });
  await ctx.db
    .update(letters)
    .set({ docxFileId: out.docxFileId, pdfFileId: out.pdfFileId, checks: { render: { ok: out.ok, checks: out.checks, pages: out.pages, templateId: template.id, templateVersion: template.version, previewFileId: out.previewFileId, at: ctx.now().toISOString() } } })
    .where(and(eq(letters.id, letterId), eq(letters.userId, ctx.userId)));
  return { ...out, templateId: template.id, problems: [] };
}
