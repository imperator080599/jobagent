import { z } from 'zod';
import { badRequest } from '../../core/errors.js';
import { getFile } from '../../core/files.js';
import { activateAtsPrompt, compareAtsPrompt, decodePromptFile, getActiveAtsPrompt, getAtsPrompt, listAtsPrompts, saveAtsPrompt } from '../../profile/ats-prompt.js';
import { sha256 } from '../../core/crypto.js';
import { deleteAnswer, listAnswers, updateAnswer, upsertAnswer } from '../../profile/answers.js';
import { approveCv, deleteCvDraft, diffCv, forkCv, getCv, importCv, listCurrentMasters, listCvVersions, updateCvDraft } from '../../profile/cv.js';
import { factHistory, listFacts, missingImportantFacts, resolveProposedFact, setFact, setSkillFact } from '../../profile/facts.js';
import { FACT_CATALOG, FACT_CATEGORIES } from '../../shared/facts.js';
import { llmAvailability } from '../../llm/index.js';
import { type AppDeps, type Ctx, body, router } from '../http.js';
import { sessionOnly } from '../middleware.js';

async function uploadedFile(c: Ctx): Promise<{ filename: string; mime: string; data: Uint8Array }> {
  const form = await c.req.parseBody();
  const f = form.file;
  if (!(f instanceof File)) throw badRequest('Aucun fichier reçu.');
  return { filename: f.name || 'document', mime: f.type || '', data: new Uint8Array(await f.arrayBuffer()) };
}

export function profileRoutes(deps: AppDeps) {
  const r = router();
  const { ctx } = deps;

  /** Vue d'ensemble du profil : ce qui est prêt, ce qui manque. */
  r.get('/summary', async (c) => {
    const uctx = c.get('uctx');
    const [masters, prompt, missing, llm, drafts] = await Promise.all([
      listCurrentMasters(ctx.db, uctx.userId),
      getActiveAtsPrompt(ctx.db, uctx.userId),
      missingImportantFacts(ctx.db, uctx.userId),
      llmAvailability(uctx),
      listCvVersions(ctx.db, uctx.userId, { kinds: ['master'] }),
    ]);
    return c.json({
      masters: masters.map((m) => ({ id: m.id, language: m.language, version: m.version, approvedAt: m.approvedAt, label: m.label, fullName: m.data.identity.fullName, experiences: m.data.experiences.length })),
      masterDrafts: drafts.filter((d) => d.status === 'draft'),
      atsPrompt: prompt ? { id: prompt.id, version: prompt.version, isDefault: prompt.isDefault, length: prompt.content.length, updatedAt: prompt.createdAt } : null,
      missingFacts: missing,
      llm,
    });
  });

  // ── CV ──
  r.get('/cv', async (c) => c.json({ versions: await listCvVersions(ctx.db, c.get('user').id, { kinds: (c.req.query('kind')?.split(',') as any) || undefined, jobId: c.req.query('jobId') || undefined }) }));

  r.post('/cv/import', sessionOnly, async (c) => {
    const res = await importCv(c.get('uctx'), await uploadedFile(c));
    return c.json({ cv: res.cv, method: res.method, warnings: res.warnings });
  });

  r.post('/cv/import-text', sessionOnly, async (c) => {
    const input = await body(c, z.object({ text: z.string().min(80, 'Texte trop court pour être un CV.') }));
    const res = await importCv(c.get('uctx'), { filename: 'cv-colle.txt', mime: 'text/plain', data: new TextEncoder().encode(input.text) });
    return c.json({ cv: res.cv, method: res.method, warnings: res.warnings });
  });

  r.get('/cv/:id', async (c) => c.json({ cv: await getCv(ctx.db, c.get('user').id, c.req.param('id')) }));

  r.put('/cv/:id', sessionOnly, async (c) => {
    const input = await body(c, z.object({ data: z.unknown().optional(), label: z.string().optional() }));
    return c.json({ cv: await updateCvDraft(c.get('uctx'), c.req.param('id'), input) });
  });

  r.post('/cv/:id/approve', sessionOnly, async (c) => {
    const cv = await approveCv(c.get('uctx'), c.req.param('id'));
    deps.kick(c);
    return c.json({ cv });
  });

  /** Ouvre un brouillon à partir d'une version validée (le master courant reste en place tant que le brouillon n'est pas validé). */
  r.post('/cv/:id/fork', sessionOnly, async (c) => c.json({ cv: await forkCv(c.get('uctx'), c.req.param('id'), { source: 'manual', changeSummary: 'Modification manuelle' }) }));

  r.delete('/cv/:id', sessionOnly, async (c) => {
    await deleteCvDraft(c.get('uctx'), c.req.param('id'));
    return c.json({ ok: true });
  });

  r.get('/cv/:id/diff', async (c) => {
    const userId = c.get('user').id;
    const target = await getCv(ctx.db, userId, c.req.param('id'));
    const againstId = c.req.query('against') || target.parentId;
    if (!againstId) return c.json({ changes: [], against: null });
    const against = await getCv(ctx.db, userId, againstId);
    return c.json({ changes: diffCv(against.data, target.data), against: { id: against.id, version: against.version, kind: against.kind } });
  });

  // ── Référentiel ──
  r.get('/facts', async (c) => {
    const facts = await listFacts(ctx.db, c.get('user').id);
    return c.json({ categories: FACT_CATEGORIES, catalog: FACT_CATALOG, facts });
  });

  r.put('/facts', sessionOnly, async (c) => {
    const input = await body(c, z.object({ key: z.string().min(1).max(200), value: z.unknown(), label: z.string().optional() }));
    const res = await setFact(ctx.db, c.get('user').id, { key: input.key, value: input.value, source: 'user', label: input.label });
    return c.json(res);
  });

  r.get('/facts/history', async (c) => c.json({ history: await factHistory(ctx.db, c.get('user').id, c.req.query('key') ?? '') }));

  r.post('/facts/:id/resolve', sessionOnly, async (c) => {
    const input = await body(c, z.object({ accept: z.boolean() }));
    await resolveProposedFact(ctx.db, c.get('user').id, c.req.param('id'), input.accept);
    return c.json({ ok: true });
  });

  r.post('/skills', sessionOnly, async (c) => {
    const input = await body(c, z.object({ name: z.string().min(1).max(120), has: z.boolean(), level: z.string().optional(), context: z.string().optional() }));
    await setSkillFact(ctx.db, c.get('user').id, input);
    deps.kick(c);
    return c.json({ ok: true });
  });

  // ── Réponses standards ──
  r.get('/answers', async (c) => c.json({ answers: await listAnswers(ctx.db, c.get('user').id) }));

  r.post('/answers', sessionOnly, async (c) => {
    const input = await body(
      c,
      z.object({
        question: z.string().min(2).max(1000),
        answer: z.string().max(5000),
        scope: z.enum(['general', 'country', 'company', 'job']).optional(),
        scopeValue: z.string().optional(),
        answerType: z.enum(['text', 'boolean', 'choice', 'number', 'date']).optional(),
        sensitive: z.boolean().optional(),
      }),
    );
    const answer = await upsertAnswer(ctx.db, c.get('user').id, input);
    deps.kick(c);
    return c.json({ answer });
  });

  r.put('/answers/:id', sessionOnly, async (c) => {
    const input = await body(c, z.object({ answer: z.string().max(5000).optional(), status: z.enum(['validated', 'pending', 'rejected']).optional(), sensitive: z.boolean().optional() }));
    return c.json({ answer: await updateAnswer(ctx.db, c.get('user').id, c.req.param('id'), input) });
  });

  r.delete('/answers/:id', sessionOnly, async (c) => {
    await deleteAnswer(ctx.db, c.get('user').id, c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── Prompt ATS ──
  r.get('/ats-prompt', async (c) => {
    const versions = await listAtsPrompts(ctx.db, c.get('user').id);
    return c.json({ active: versions.find((v) => v.isActive) ?? null, versions: versions.map((v) => ({ id: v.id, version: v.version, note: v.note, isDefault: v.isDefault, isActive: v.isActive, createdAt: v.createdAt, length: v.content.length, sha256: v.sha256 })) });
  });

  r.get('/ats-prompt/:id', async (c) => {
    const versions = await listAtsPrompts(ctx.db, c.get('user').id);
    const v = versions.find((x) => x.id === c.req.param('id'));
    if (!v) throw badRequest('Version inconnue.');
    return c.json({ prompt: v });
  });

  r.post('/ats-prompt', sessionOnly, async (c) => {
    const input = await body(c, z.object({ content: z.string(), note: z.string().optional() }));
    const res = await saveAtsPrompt(c.get('uctx'), input.content, input.note);
    return c.json(res);
  });

  r.post('/ats-prompt/:id/activate', sessionOnly, async (c) => c.json({ prompt: await activateAtsPrompt(c.get('uctx'), c.req.param('id')) }));

  /** Import du prompt depuis le fichier d'origine : les octets sont conservés tels quels (aucune normalisation). */
  r.post('/ats-prompt/import', sessionOnly, async (c) => {
    const file = await uploadedFile(c);
    if (file.data.byteLength > 400_000) throw badRequest('Fichier trop volumineux pour un prompt (400 Ko maximum).');
    const decoded = await decodePromptFile(file);
    const res = await saveAtsPrompt(c.get('uctx'), decoded.text, `Importé du fichier « ${file.filename.slice(0, 120)} »`);
    return c.json({ ...res, file: { name: file.filename, sha256: decoded.fileSha256, bytes: file.data.byteLength }, textSha256: decoded.textSha256, storedSha256: res.prompt.sha256, byteExact: decoded.byteExact, identicalToFile: decoded.byteExact && res.prompt.sha256 === decoded.fileSha256, encoding: decoded.encoding, notes: decoded.notes });
  });

  /** Compare un texte (collé ou fichier) à une version enregistrée, caractère par caractère. */
  r.post('/ats-prompt/compare', sessionOnly, async (c) => {
    const type = c.req.header('content-type') ?? '';
    let reference: string;
    let notes: string[] = [];
    let fileSha256: string | null = null;
    let versionId: string | undefined;
    if (type.includes('multipart/form-data')) {
      const form = await c.req.parseBody();
      versionId = typeof form.versionId === 'string' && form.versionId ? form.versionId : undefined;
      const f = form.file;
      if (!(f instanceof File)) throw badRequest('Aucun fichier reçu.');
      const decoded = await decodePromptFile({ filename: f.name || 'prompt.txt', mime: f.type || '', data: new Uint8Array(await f.arrayBuffer()) });
      reference = decoded.text;
      notes = decoded.notes;
      fileSha256 = decoded.fileSha256;
    } else {
      const input = await body(c, z.object({ content: z.string().min(1).max(400_000), versionId: z.string().optional() }));
      reference = input.content;
      versionId = input.versionId;
      notes = ["Texte collé : un navigateur peut convertir les fins de ligne ou certains espaces lors du copier-coller. Pour une preuve octet par octet, comparez avec le fichier d'origine."];
    }
    return c.json({ ...(await compareAtsPrompt(c.get('uctx'), reference, versionId)), fileSha256, notes });
  });

  /** Texte exact d'une version, tel qu'enregistré (pour le télécharger et calculer soi-même son empreinte). */
  r.get('/ats-prompt/:id/raw', async (c) => {
    const v = await getAtsPrompt(ctx.db, c.get('user').id, c.req.param('id'));
    const data = new TextEncoder().encode(v.content);
    return new Response(data, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename="prompt-ats-v${v.version}.txt"`,
        'x-content-sha256': sha256(data),
        'x-stored-sha256': v.sha256,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  });

  return r;
}

/** Téléchargement d'un document de l'utilisateur (CV source, PDF/DOCX générés…). */
export function filesRoutes(deps: AppDeps) {
  const r = router();
  r.get('/:id', async (c) => {
    const file = await getFile(deps.ctx.db, c.get('user').id, c.req.param('id'));
    if (!file) return c.json({ error: { code: 'not_found', message: 'Document introuvable.' } }, 404);
    const inline = file.mime === 'application/pdf' || file.mime.startsWith('image/');
    const safeName = file.filename.replace(/[^\w.\- ()àâäéèêëïîôöùûüçÀÂÄÉÈÊËÏÎÔÖÙÛÜÇ]/g, '_');
    return new Response(Buffer.from(file.data), {
      headers: {
        'content-type': inline ? file.mime : 'application/octet-stream',
        'content-disposition': `${inline && c.req.query('download') !== '1' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(safeName)}`,
        'content-length': String(file.size),
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
      },
    });
  });
  return r;
}
