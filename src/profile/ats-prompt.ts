// Prompt ATS personnel : enregistré tel quel, versionné, jamais réécrit.
// Chaque analyse référence la version exacte (identifiant + empreinte) utilisée.
import { and, desc, eq } from 'drizzle-orm';
import type { UserContext } from '../core/context.js';
import type { Db } from '../db/client.js';
import { atsPrompts } from '../db/schema.js';
import { newId } from '../db/ids.js';
import { logActivity } from '../core/activity.js';
import { sha256 } from '../core/crypto.js';
import { badRequest, notFound } from '../core/errors.js';
import { comparePrompts } from '../pipeline/ats-integrity.js';
import { resolveAction } from '../core/inbox.js';

export type AtsPrompt = typeof atsPrompts.$inferSelect;

/**
 * Prompt fourni par défaut, en attendant le prompt personnel de l'utilisateur.
 * Il suit la méthode décrite par l'utilisateur (note sur 20, 40 mots-clés, mots-clés
 * absents, lisibilité, recommandations, CV optimisé sans invention).
 */
export const DEFAULT_ATS_PROMPT = `Tu es un expert en recrutement et en systèmes de suivi des candidatures (ATS), spécialisé dans les métiers de la finance d'entreprise, de l'audit et du conseil en transactions.

Analyse l'adéquation entre le CV et l'offre d'emploi fournis, avec rigueur et sans complaisance. Appuie chaque constat sur un élément précis du CV ou de l'offre. Ne suppose jamais qu'une compétence est maîtrisée parce qu'elle figure dans l'offre : seul ce qui est écrit dans le CV compte.

Structure ta réponse ainsi :

## 1. Adéquation du profil
Synthèse en cinq à huit lignes : le profil répond-il au besoin, sur quels points, avec quelles réserves.

## 2. Note globale
Une note sur 20, au format « Note globale : X/20 », suivie de la justification. Barème d'interprétation :
- 15/20 et plus : excellente adéquation ;
- de 13 à 14,99 : candidature intéressante ;
- de 11 à 12,99 : adéquation limitée ;
- moins de 11 : faible adéquation.

## 3. Critères de recrutement
Tableau des critères de l'offre (expérience, formation, compétences techniques, compétences comportementales, langues, autres exigences) avec pour chacun : exigence de l'offre, élément correspondant du CV, niveau de couverture (couvert, partiel, absent).

## 4. Mots-clés de l'offre
Liste numérotée des 40 mots-clés les plus importants de l'offre, par ordre d'importance, en indiquant pour chacun s'il est présent ou absent du CV.

## 5. Mots-clés absents du CV
Liste des mots-clés de l'offre absents du CV, en distinguant ceux que le candidat pourrait légitimement ajouter (expérience réelle mais formulée autrement) de ceux qui correspondent à une compétence non démontrée.

## 6. Lisibilité, structure et format
Problèmes susceptibles de gêner un ATS ou un recruteur : structure, titres de rubriques, longueur, formulations, dates, mise en forme.

## 7. Points forts
## 8. Points faibles et risques
## 9. Recommandations
Recommandations concrètes et hiérarchisées pour améliorer la candidature.

## 10. Proposition de CV optimisé
Réécriture du CV adaptée à l'offre. Contraintes absolues : n'invente aucune expérience, responsabilité, compétence, certification ni résultat chiffré ; ne modifie aucune date, aucun intitulé de poste, aucun nom d'entreprise ; reformule uniquement ce qui figure déjà dans le CV.`;

export async function listAtsPrompts(db: Db, userId: string): Promise<AtsPrompt[]> {
  return db.select().from(atsPrompts).where(eq(atsPrompts.userId, userId)).orderBy(desc(atsPrompts.version));
}

export async function getActiveAtsPrompt(db: Db, userId: string): Promise<AtsPrompt | null> {
  const [row] = await db.select().from(atsPrompts).where(and(eq(atsPrompts.userId, userId), eq(atsPrompts.isActive, true)));
  return row ?? null;
}

export async function getAtsPrompt(db: Db, userId: string, id: string): Promise<AtsPrompt> {
  const [row] = await db.select().from(atsPrompts).where(and(eq(atsPrompts.userId, userId), eq(atsPrompts.id, id)));
  if (!row) throw notFound('Version du prompt introuvable.');
  return row;
}

async function insertVersion(db: Db, userId: string, content: string, note: string, isDefault: boolean): Promise<AtsPrompt> {
  return db.transaction(async (tx) => {
    const [last] = await tx.select({ v: atsPrompts.version }).from(atsPrompts).where(eq(atsPrompts.userId, userId)).orderBy(desc(atsPrompts.version)).limit(1);
    await tx.update(atsPrompts).set({ isActive: false }).where(and(eq(atsPrompts.userId, userId), eq(atsPrompts.isActive, true)));
    const [row] = await tx
      .insert(atsPrompts)
      .values({ id: newId('atp'), userId, version: (last?.v ?? 0) + 1, content, sha256: sha256(content), note, isDefault, isActive: true })
      .returning();
    return row!;
  });
}

/** Enregistre une nouvelle version du prompt, strictement telle que saisie, et l'active. */
export async function saveAtsPrompt(ctx: UserContext, content: string, note = ''): Promise<{ prompt: AtsPrompt; created: boolean }> {
  if (!content.trim()) throw badRequest('Le prompt est vide.');
  if (content.length > 100_000) throw badRequest('Le prompt est trop long (100 000 caractères maximum).');
  const active = await getActiveAtsPrompt(ctx.db, ctx.userId);
  // Aucune normalisation : même un espace modifié crée une nouvelle version traçable.
  if (active && active.content === content) return { prompt: active, created: false };
  const prompt = await insertVersion(ctx.db, ctx.userId, content, note.slice(0, 500), false);
  await logActivity(ctx.db, { userId: ctx.userId, actor: 'user', action: 'ats_prompt.saved', entityType: 'ats_prompt', entityId: prompt.id, summary: `Prompt ATS enregistré (version ${prompt.version})`, data: { sha256: prompt.sha256, length: content.length } });
  await resolveAction(ctx.db, ctx.userId, { dedupKey: 'setup.ats_prompt' }, { promptId: prompt.id });
  return { prompt, created: true };
}

export async function activateAtsPrompt(ctx: UserContext, id: string): Promise<AtsPrompt> {
  const target = await getAtsPrompt(ctx.db, ctx.userId, id);
  if (target.isActive) return target;
  const row = await ctx.db.transaction(async (tx) => {
    await tx.update(atsPrompts).set({ isActive: false }).where(and(eq(atsPrompts.userId, ctx.userId), eq(atsPrompts.isActive, true)));
    const [r] = await tx.update(atsPrompts).set({ isActive: true }).where(eq(atsPrompts.id, id)).returning();
    return r!;
  });
  await logActivity(ctx.db, { userId: ctx.userId, actor: 'user', action: 'ats_prompt.activated', entityType: 'ats_prompt', entityId: id, summary: `Prompt ATS : version ${row.version} réactivée` });
  return row;
}

export async function ensureDefaultAtsPrompt(db: Db, userId: string): Promise<void> {
  const [any] = await db.select({ id: atsPrompts.id }).from(atsPrompts).where(eq(atsPrompts.userId, userId)).limit(1);
  if (!any) await insertVersion(db, userId, DEFAULT_ATS_PROMPT, 'Prompt par défaut fourni avec JobAgent', true);
}

export interface DecodedPromptFile {
  text: string;
  /** Empreinte des octets du fichier. Égale à celle du texte lorsque le fichier est en UTF-8 : aucun octet n'a été changé. */
  fileSha256: string;
  textSha256: string;
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'docx';
  /** Le texte enregistré est-il la reproduction exacte des octets du fichier ? */
  byteExact: boolean;
  bom: boolean;
  notes: string[];
}

/**
 * Lit un fichier de prompt sans rien normaliser : ni retours à la ligne, ni espaces, ni
 * marque d'ordre des octets (BOM). Un fichier qui n'est pas en UTF-8 valide est refusé
 * plutôt que deviné ; un document Word est accepté, mais signalé comme texte extrait.
 */
export async function decodePromptFile(file: { filename: string; mime: string; data: Uint8Array }): Promise<DecodedPromptFile> {
  const bytes = file.data;
  const fileSha256 = sha256(bytes);
  const notes: string[] = [];
  const lower = file.filename.toLowerCase();
  if (lower.endsWith('.docx') || file.mime.includes('wordprocessingml')) {
    const { extractDocumentText } = await import('./extract.js');
    const doc = await extractDocumentText(file);
    notes.push("Texte extrait d'un document Word : la mise en forme et certains retours à la ligne peuvent différer de ce que vous voyez dans Word. Pour une preuve octet par octet, enregistrez le prompt en texte brut UTF-8 (.txt).");
    return { text: doc.text, fileSha256, textSha256: sha256(doc.text), encoding: 'docx', byteExact: false, bom: false, notes };
  }
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    const encoding = bytes[0] === 0xff ? 'utf-16le' : 'utf-16be';
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    notes.push(`Fichier en ${encoding.toUpperCase()} : le texte est identique, mais il est enregistré en UTF-8. Comparez les empreintes du texte, pas celles du fichier.`);
    return { text, fileSha256, textSha256: sha256(text), encoding, byteExact: false, bom: true, notes };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw badRequest("Ce fichier n'est pas encodé en UTF-8. Enregistrez-le en « Texte brut UTF-8 » (ou collez le prompt) : JobAgent ne devine pas un encodage, pour ne modifier aucun caractère.");
  }
  const bom = text.startsWith('\uFEFF');
  if (bom) notes.push("Le fichier commence par une marque d'ordre des octets (BOM) : elle est conservée telle quelle.");
  if (/\r\n/.test(text)) notes.push('Le fichier utilise des fins de ligne Windows (CRLF) : elles sont conservées telles quelles.');
  const textSha256 = sha256(text);
  return { text, fileSha256, textSha256, encoding: 'utf-8', byteExact: textSha256 === fileSha256, bom, notes };
}

/** Compare un texte de référence (par ex. le fichier d'origine de l'utilisateur) à une version enregistrée. */
export async function compareAtsPrompt(ctx: UserContext, reference: string, versionId?: string) {
  const target = versionId ? await getAtsPrompt(ctx.db, ctx.userId, versionId) : await getActiveAtsPrompt(ctx.db, ctx.userId);
  if (!target) throw notFound('Aucune version du prompt ATS à comparer.');
  const result = comparePrompts(reference, target.content);
  return {
    version: { id: target.id, version: target.version, sha256: target.sha256, chars: target.content.length, storedShaValid: sha256(target.content) === target.sha256 },
    reference: { sha256: result.referenceSha256, chars: reference.length },
    identical: result.identical,
    lineEndingsOnly: result.lineEndingsOnly,
    differences: result.differences,
  };
}
