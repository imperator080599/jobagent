// Synchronisation LinkedIn ↔ CV master. LinkedIn n'est jamais recopié aveuglément :
// chaque écart devient une proposition, et le master n'évolue qu'après validation
// (sauf mise à jour automatique explicitement autorisée pour les ajouts factuels).
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { UserContext } from '../../core/context.js';
import { logActivity } from '../../core/activity.js';
import { sha256 } from '../../core/crypto.js';
import { ConfigError, badRequest, notFound } from '../../core/errors.js';
import { saveFile } from '../../core/files.js';
import { raiseAction, resolveAction } from '../../core/inbox.js';
import { getSecret } from '../../core/secrets.js';
import { getSetting } from '../../core/settings.js';
import { cvVersions, linkedinSnapshots, profileDiffs } from '../../db/schema.js';
import { newId } from '../../db/ids.js';
import { type CvData, assignIds } from '../../shared/cv.js';
import { structureCv } from '../cv-import.js';
import { approveCv, forkCv, getCurrentMaster, updateCvDraft } from '../cv.js';
import { extractDocumentText, sniffKind } from '../extract.js';
import { type DiffKind, type ProfileDiff, diffProfile } from './diff.js';
import { fetchDmaSnapshot } from './dma.js';
import { readLinkedinExport, recordsToProfile } from './records.js';

export type Snapshot = typeof linkedinSnapshots.$inferSelect;
export type StoredDiff = typeof profileDiffs.$inferSelect;

/** Ajouts purement factuels, éligibles à la mise à jour automatique si l'utilisateur l'a autorisée. Les contradictions n'en font jamais partie. */
const AUTO_APPLICABLE: DiffKind[] = ['experience_missing_in_cv', 'education_missing_in_cv', 'certification_missing_in_cv', 'language_missing_in_cv'];

export interface SyncResult {
  snapshot: Snapshot;
  changed: boolean;
  newDiffs: number;
  openDiffs: number;
  autoApplied: number;
}

function snapshotHash(data: CvData): string {
  return sha256(JSON.stringify(data));
}

export async function lastSnapshot(ctx: UserContext): Promise<Snapshot | null> {
  const [row] = await ctx.db.select().from(linkedinSnapshots).where(eq(linkedinSnapshots.userId, ctx.userId)).orderBy(desc(linkedinSnapshots.fetchedAt)).limit(1);
  return row ?? null;
}

export async function listDiffs(ctx: UserContext, status: StoredDiff['status'][] = ['open']): Promise<StoredDiff[]> {
  return ctx.db
    .select()
    .from(profileDiffs)
    .where(and(eq(profileDiffs.userId, ctx.userId), inArray(profileDiffs.status, status)))
    .orderBy(desc(profileDiffs.createdAt));
}

async function storeSnapshot(ctx: UserContext, method: Snapshot['method'], data: CvData, fileId?: string): Promise<SyncResult> {
  const hash = snapshotHash(data);
  const previous = await lastSnapshot(ctx);
  const now = ctx.now();
  if (previous && previous.contentHash === hash) {
    // Profil inchangé : on note seulement la date de vérification, sans rien signaler.
    const [touched] = await ctx.db.update(linkedinSnapshots).set({ fetchedAt: now }).where(eq(linkedinSnapshots.id, previous.id)).returning();
    const open = await listDiffs(ctx);
    return { snapshot: touched!, changed: false, newDiffs: 0, openDiffs: open.length, autoApplied: 0 };
  }
  const [snapshot] = await ctx.db
    .insert(linkedinSnapshots)
    .values({ id: newId('lis'), userId: ctx.userId, method, data, contentHash: hash, fileId: fileId ?? null, fetchedAt: now })
    .returning();
  await logActivity(ctx.db, { userId: ctx.userId, actor: 'system', action: 'linkedin.snapshot', entityType: 'linkedin', entityId: snapshot!.id, summary: `Profil LinkedIn importé (${method})`, data: { experiences: data.experiences.length, education: data.education.length } });
  return compare(ctx, snapshot!);
}

/** Compare l'instantané au master courant et enregistre les écarts (jamais deux fois le même). */
async function compare(ctx: UserContext, snapshot: Snapshot): Promise<SyncResult> {
  const master = await getCurrentMaster(ctx.db, ctx.userId, snapshot.data.language);
  if (!master) {
    await raiseAction(ctx.db, { userId: ctx.userId, type: 'setup.cv_master', title: 'Importer votre CV master', body: { text: 'Votre profil LinkedIn est importé. Importez votre CV master pour que les deux puissent être comparés.', link: '/profil/cv' }, priority: 100, dedupKey: 'setup.cv_master' });
    return { snapshot, changed: true, newDiffs: 0, openDiffs: 0, autoApplied: 0 };
  }
  const found = diffProfile(master.data, snapshot.data);
  const foundKeys = new Set(found.map((d) => d.dedupKey));
  let newDiffs = 0;
  for (const d of found) {
    const inserted = await ctx.db
      .insert(profileDiffs)
      .values({ id: newId('pdf'), userId: ctx.userId, snapshotId: snapshot.id, kind: d.kind, dedupKey: d.dedupKey, summary: d.summary, cvValue: d.cvValue, linkedinValue: d.linkedinValue, proposal: d.proposal ?? null })
      .onConflictDoNothing({ target: [profileDiffs.userId, profileDiffs.dedupKey] })
      .returning({ id: profileDiffs.id });
    if (inserted.length) newDiffs++;
  }
  // Écarts encore ouverts mais disparus (corrigés côté LinkedIn ou CV) : clos sans solliciter l'utilisateur.
  const open = await listDiffs(ctx);
  const vanished = open.filter((d) => !foundKeys.has(d.dedupKey));
  if (vanished.length) {
    await ctx.db.update(profileDiffs).set({ status: 'ignored', decidedAt: ctx.now() }).where(inArray(profileDiffs.id, vanished.map((d) => d.id)));
  }

  let autoApplied = 0;
  const sync = await getSetting(ctx.db, ctx.userId, 'linkedin.sync');
  if (sync.autoApplyFactual) {
    const eligible = (await listDiffs(ctx)).filter((d) => AUTO_APPLICABLE.includes(d.kind as DiffKind) && d.proposal);
    for (const d of eligible) await decideDiff(ctx, d.id, 'accept', { actor: 'system' });
    autoApplied = eligible.length;
    if (eligible.length) {
      const draft = await pendingLinkedinDraft(ctx);
      if (draft) {
        await approveCv(ctx, draft.id);
        await logActivity(ctx.db, { userId: ctx.userId, actor: 'system', action: 'linkedin.auto_applied', entityType: 'cv', entityId: draft.id, level: 'warn', summary: `CV master mis à jour automatiquement depuis LinkedIn (${eligible.length} ajout(s) factuel(s), mise à jour automatique autorisée)` });
      }
    }
  }

  const remaining = await listDiffs(ctx);
  // On ne sollicite l'utilisateur que pour ce qui appelle une décision de sa part.
  const actionable = remaining.filter((d) => d.proposal || d.kind === 'language_level_mismatch');
  if (actionable.length) {
    await raiseAction(ctx.db, {
      userId: ctx.userId,
      type: 'linkedin.diffs',
      title: `${actionable.length} écart(s) entre LinkedIn et votre CV master`,
      body: { count: actionable.length, link: '/profil/linkedin', examples: actionable.slice(0, 3).map((d) => d.summary) },
      priority: 55,
      dedupKey: 'linkedin.diffs',
      reopen: newDiffs > 0,
    });
  } else {
    await resolveAction(ctx.db, ctx.userId, { dedupKey: 'linkedin.diffs' }, { reason: 'no_open_diffs' });
  }
  return { snapshot, changed: true, newDiffs, openDiffs: remaining.length, autoApplied };
}

/** Importe un profil LinkedIn : archive ZIP officielle, PDF « Enregistrer au format PDF », ou texte collé. */
export async function importLinkedinFile(ctx: UserContext, file: { filename: string; mime: string; data: Uint8Array }): Promise<SyncResult> {
  if (file.data.byteLength > 60 * 1024 * 1024) throw badRequest('Fichier trop volumineux (60 Mo maximum).');
  const isZip = file.data[0] === 0x50 && file.data[1] === 0x4b && !/\.docx$/i.test(file.filename);
  if (isZip) {
    const records = readLinkedinExport(file.data);
    if (!records.PROFILE?.length && !records.POSITIONS?.length) throw badRequest("Cette archive ne contient pas de données de profil LinkedIn (Profile.csv, Positions.csv…). Demandez l'archive depuis LinkedIn → Préférences → Confidentialité des données → Obtenir une copie de vos données.");
    // L'archive complète peut contenir messages et contacts : seul le profil structuré est conservé, pas le fichier.
    return storeSnapshot(ctx, 'export_zip', recordsToProfile(records));
  }
  const kind = sniffKind(file.filename, file.mime, file.data);
  if (!kind) throw badRequest('Format non pris en charge. Importez l\'archive ZIP LinkedIn, le PDF de votre profil, ou collez son texte.');
  const doc = await extractDocumentText(file);
  if (doc.text.length < 80) throw badRequest('Aucun texte exploitable dans ce document.');
  const structured = await structureCv(ctx, { text: doc.text, pdf: kind === 'pdf' ? file.data : undefined, kind: 'linkedin_profile' });
  const fileId = kind === 'pdf' ? await saveFile(ctx.db, { userId: ctx.userId, kind: 'linkedin_profile', filename: file.filename, mime: 'application/pdf', data: file.data }) : undefined;
  return storeSnapshot(ctx, kind === 'pdf' ? 'profile_pdf' : 'paste', assignIds(structured.cv), fileId);
}

/** Synchronisation par l'API officielle de portabilité (membres UE/EEE/Suisse). */
export async function syncLinkedinApi(ctx: UserContext): Promise<SyncResult> {
  const token = await getSecret(ctx.db, ctx.env.appSecret, ctx.userId, 'linkedin_access_token');
  if (!token) throw new ConfigError("Aucun jeton d'accès LinkedIn n'est enregistré (Profil → LinkedIn).", 'linkedin_token_missing');
  const records = await fetchDmaSnapshot(ctx, token);
  if (!records.PROFILE?.length && !records.POSITIONS?.length) throw new Error("LinkedIn n'a renvoyé aucune donnée de profil. Le traitement initial peut prendre quelques heures après l'émission du jeton.");
  return storeSnapshot(ctx, 'dma_api', recordsToProfile(records));
}

async function pendingLinkedinDraft(ctx: UserContext) {
  const [row] = await ctx.db
    .select()
    .from(cvVersions)
    .where(and(eq(cvVersions.userId, ctx.userId), eq(cvVersions.kind, 'master'), eq(cvVersions.status, 'draft'), eq(cvVersions.source, 'linkedin')))
    .orderBy(desc(cvVersions.createdAt))
    .limit(1);
  return row ?? null;
}

function applyProposal(cv: CvData, proposal: Record<string, any>): { cv: CvData; note: string } {
  const out = structuredClone(cv);
  switch (proposal.action) {
    case 'add_experience': {
      const e = proposal.experience;
      // Insertion chronologique (les plus récentes en premier).
      const idx = out.experiences.findIndex((x) => (x.start || '0') < (e.start || '0'));
      out.experiences.splice(idx < 0 ? out.experiences.length : idx, 0, { ...e, id: '', bullets: (e.bullets ?? []).map((b: any) => ({ id: '', text: b.text })) });
      return { cv: out, note: `Ajout de l'expérience « ${e.title} — ${e.company} »` };
    }
    case 'add_education': {
      const e = proposal.education;
      out.education.push({ ...e, id: '', details: (e.details ?? []).map((b: any) => ({ id: '', text: b.text })) });
      return { cv: out, note: `Ajout de la formation « ${e.school} »` };
    }
    case 'set_experience_field': {
      const e = out.experiences.find((x) => x.id === proposal.experienceId);
      if (e) (e as any)[proposal.field] = proposal.value;
      return { cv: out, note: `Mise à jour (${proposal.field}) de l'expérience ${e?.company ?? ''}` };
    }
    case 'set_education_field': {
      const e = out.education.find((x) => x.id === proposal.educationId);
      if (e) (e as any)[proposal.field] = proposal.value;
      return { cv: out, note: `Mise à jour (${proposal.field}) de la formation ${e?.school ?? ''}` };
    }
    case 'add_bullets': {
      const e = out.experiences.find((x) => x.id === proposal.experienceId);
      if (e) for (const text of proposal.bullets as string[]) e.bullets.push({ id: '', text });
      return { cv: out, note: `Ajout de ${proposal.bullets.length} mission(s) à l'expérience ${e?.company ?? ''}` };
    }
    case 'add_skills': {
      const skills = (proposal.selected ?? proposal.skills) as string[];
      const group = out.skills[out.skills.length - 1];
      if (group) group.items.push(...skills.filter((s) => !group.items.includes(s)));
      else out.skills.push({ id: '', label: '', items: skills });
      return { cv: out, note: `Ajout de ${skills.length} compétence(s)` };
    }
    case 'add_certification':
      out.certifications.push({ ...proposal.certification, id: '' });
      return { cv: out, note: `Ajout de la certification « ${proposal.certification.name} »` };
    case 'add_language':
      out.languages.push({ ...proposal.language, id: '' });
      return { cv: out, note: `Ajout de la langue « ${proposal.language.language} »` };
    default:
      return { cv: out, note: '' };
  }
}

/**
 * Décision de l'utilisateur sur un écart.
 *  - accept : la modification est reportée dans un brouillon de CV master (à valider ensuite) ;
 *  - reject / ignore : l'écart est clos et ne sera plus jamais remonté.
 */
export async function decideDiff(ctx: UserContext, diffId: string, decision: 'accept' | 'reject' | 'ignore', opts: { selected?: string[]; actor?: string } = {}): Promise<{ draftId?: string }> {
  const [diff] = await ctx.db.select().from(profileDiffs).where(and(eq(profileDiffs.id, diffId), eq(profileDiffs.userId, ctx.userId)));
  if (!diff) throw notFound('Écart introuvable.');
  if (diff.status !== 'open') return {};
  let draftId: string | undefined;
  if (decision === 'accept' && diff.proposal) {
    const master = await getCurrentMaster(ctx.db, ctx.userId);
    if (!master) throw badRequest('Aucun CV master à mettre à jour.');
    let draft = await pendingLinkedinDraft(ctx);
    if (!draft) draft = await forkCv(ctx, master.id, { source: 'linkedin', changeSummary: '', createdBy: 'agent:profile' });
    const proposal = { ...(diff.proposal as Record<string, any>), ...(opts.selected ? { selected: opts.selected } : {}) };
    const applied = applyProposal(draft.data, proposal);
    const updated = await updateCvDraft(ctx, draft.id, { data: applied.cv });
    const summary = [draft.changeSummary, applied.note].filter(Boolean).join(' ; ');
    await ctx.db.update(cvVersions).set({ changeSummary: summary }).where(eq(cvVersions.id, updated.id));
    draftId = updated.id;
    if (opts.actor !== 'system') {
      await raiseAction(ctx.db, { userId: ctx.userId, type: 'cv.master.review', title: 'Valider la mise à jour de votre CV master (LinkedIn)', body: { cvId: updated.id, changeSummary: summary, link: '/profil/cv' }, priority: 80, dedupKey: `cv.master.review:${updated.id}` });
    }
  }
  await ctx.db
    .update(profileDiffs)
    .set({ status: decision === 'accept' ? 'accepted' : decision === 'reject' ? 'rejected' : 'ignored', decidedAt: ctx.now() })
    .where(eq(profileDiffs.id, diffId));
  await logActivity(ctx.db, { userId: ctx.userId, actor: opts.actor ?? 'user', action: `linkedin.diff_${decision}`, entityType: 'profile_diff', entityId: diffId, summary: `Écart LinkedIn ${decision === 'accept' ? 'accepté' : 'écarté'} : ${diff.summary}` });
  const remaining = (await listDiffs(ctx)).filter((d) => d.proposal || d.kind === 'language_level_mismatch');
  if (!remaining.length) await resolveAction(ctx.db, ctx.userId, { dedupKey: 'linkedin.diffs' }, { reason: 'all_decided' });
  return { draftId };
}

export type { ProfileDiff };
