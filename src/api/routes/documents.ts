// « Mes documents » : templates (CV, lettre), versions, aperçus et documents générés.
import { and, desc, eq, inArray } from 'drizzle-orm';
import { badRequest } from '../../core/errors.js';
import { cvVersions, letters, jobs } from '../../db/schema.js';
import { documentCapabilities } from '../../docs/convert.js';
import { renderCvVersion } from '../../docs/generate.js';
import { activateTemplate, importCvTemplate, importLetterTemplate, listTemplates } from '../../docs/templates.js';
import { getCurrentMaster } from '../../profile/cv.js';
import { type AppDeps, type Ctx, router } from '../http.js';
import { sessionOnly } from '../middleware.js';

async function uploaded(c: Ctx) {
  const form = await c.req.parseBody();
  const f = form.file;
  if (!(f instanceof File)) throw badRequest('Aucun fichier reçu.');
  if (f.size > 10 * 1024 * 1024) throw badRequest('Fichier trop volumineux (10 Mo maximum).');
  return { file: { filename: f.name || 'template', mime: f.type || '', data: new Uint8Array(await f.arrayBuffer()) }, language: typeof form.language === 'string' ? form.language : undefined };
}

export function documentsRoutes(deps: AppDeps) {
  const r = router();
  const { ctx } = deps;

  r.get('/templates', async (c) => {
    const rows = await listTemplates(ctx.db, c.get('user').id);
    return c.json({
      capabilities: await documentCapabilities(),
      templates: rows.map((t) => {
        const p = t.profile as Record<string, any>;
        return {
          id: t.id,
          kind: t.kind,
          name: t.name,
          language: t.language,
          version: t.version,
          isActive: t.isActive,
          origin: t.origin,
          createdAt: t.createdAt,
          notes: t.notes,
          sourceFileId: t.sourceFileId,
          docxFileId: t.docxFileId,
          pdfFileId: t.pdfFileId,
          previewFileId: t.previewFileId,
          fonts: (p.fonts ?? []).slice(0, 4),
          sections: t.kind === 'letter' ? (p.sections ?? []).map((s: any) => ({ label: s.label, brief: s.brief })) : undefined,
          mapped: t.kind === 'cv' ? Object.keys(p.elements ?? {}).length : undefined,
          unmatched: t.kind === 'cv' ? (p.unmatched ?? []).length : undefined,
        };
      }),
    });
  });

  r.post('/templates/letter', sessionOnly, async (c) => {
    const { file } = await uploaded(c);
    return c.json({ template: await importLetterTemplate(c.get('uctx'), file) });
  });

  r.post('/templates/cv', sessionOnly, async (c) => {
    const { file, language } = await uploaded(c);
    const master = await getCurrentMaster(ctx.db, c.get('user').id, language);
    if (!master) throw badRequest("Importez et validez d'abord votre CV master : le template de CV lui est rattaché.");
    return c.json({ template: await importCvTemplate(c.get('uctx'), file, master) });
  });

  r.post('/templates/:id/activate', sessionOnly, async (c) => c.json({ template: await activateTemplate(c.get('uctx'), c.req.param('id')) }));

  /** (Re)génère le document d'une version de CV dans le template actif, avec contrôle du rendu. */
  r.post('/cv/:id/render', sessionOnly, async (c) => c.json(await renderCvVersion(c.get('uctx'), c.req.param('id'))));

  /** Documents générés pour les candidatures : chaque CV et chaque lettre reste associé à son offre. */
  r.get('/generated', async (c) => {
    const userId = c.get('user').id;
    const cvs = await ctx.db
      .select({ id: cvVersions.id, jobId: cvVersions.jobId, label: cvVersions.label, status: cvVersions.status, version: cvVersions.version, createdAt: cvVersions.createdAt, pdfFileId: cvVersions.pdfFileId, docxFileId: cvVersions.docxFileId, checks: cvVersions.checks })
      .from(cvVersions)
      .where(and(eq(cvVersions.userId, userId), eq(cvVersions.kind, 'application')))
      .orderBy(desc(cvVersions.createdAt))
      .limit(200);
    const ls = await ctx.db
      .select({ id: letters.id, jobId: letters.jobId, status: letters.status, language: letters.language, createdAt: letters.createdAt, pdfFileId: letters.pdfFileId, docxFileId: letters.docxFileId, kind: letters.kind })
      .from(letters)
      .where(eq(letters.userId, userId))
      .orderBy(desc(letters.createdAt))
      .limit(200);
    const jobIds = [...new Set([...cvs.map((x) => x.jobId), ...ls.map((x) => x.jobId)].filter((x): x is string => Boolean(x)))];
    const jobRows = jobIds.length ? await ctx.db.select({ id: jobs.id, title: jobs.title, companyName: jobs.companyName }).from(jobs).where(and(eq(jobs.userId, userId), inArray(jobs.id, jobIds))) : [];
    const byId = new Map(jobRows.map((j) => [j.id, j]));
    return c.json({
      cvs: cvs.map((x) => ({ ...x, checks: undefined, render: (x.checks as any)?.render ?? null, job: x.jobId ? byId.get(x.jobId) ?? null : null })),
      letters: ls.map((x) => ({ ...x, job: x.jobId ? byId.get(x.jobId) ?? null : null })),
    });
  });

  return r;
}
