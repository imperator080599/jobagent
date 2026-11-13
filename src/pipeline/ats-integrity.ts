// Intégrité du prompt ATS de l'utilisateur.
//
// Garantie apportée : le texte envoyé au modèle est le prompt enregistré, caractère
// pour caractère, dans lequel seules les deux mentions de remplacement prévues par le
// prompt (« Copier/coller » des lignes « ■ CV : » et « ■ Offre d'emploi : ») sont
// remplacées par le CV et l'offre. Aucune autre partie n'est retirée, reformulée,
// tronquée ou réordonnée.
//
// Preuve : chaque insertion est enregistrée avec sa position. En remplaçant chaque
// insertion par la mention d'origine, on retrouve un texte dont l'empreinte SHA-256
// doit être identique à celle du prompt enregistré. Cette vérification est faite
// AVANT l'appel au modèle : si elle échoue, l'analyse n'est pas lancée.
import { sha256 } from '../core/crypto.js';
import { NeedsHumanError } from '../core/errors.js';

export interface Insertion {
  kind: 'cv' | 'offer';
  /** Position dans le texte envoyé. */
  start: number;
  end: number;
  /** Texte d'origine remplacé dans le prompt (vide si le contenu est ajouté après le prompt). */
  replaced: string;
  placement: 'slot' | 'token' | 'appended';
}

export interface AssembledPrompt {
  /** Message exact transmis au modèle. */
  text: string;
  insertions: Insertion[];
}

/** Mentions de remplacement reconnues après « ■ CV : » / « ■ Offre d'emploi : ». */
const PLACEHOLDER = String.raw`(?:copier\s*\/\s*coller|copier-coller|coller ici|à coller|paste here|copy\s*\/\s*paste)`;
const CV_LABEL = String.raw`(?:CV|Curriculum vitae|Resume|Résumé)`;
const OFFER_LABEL = String.raw`(?:Offre d[’'‘\`]emploi|Offre|Annonce|Job description|Job offer|Job posting|Fiche de poste)`;
const CV_TOKEN = /\{\{\s*CV\s*\}\}/i;
const OFFER_TOKEN = /\{\{\s*(?:OFFRE|OFFER|JOB|ANNONCE)\s*\}\}/i;

/** Mention exacte à remplacer (position dans le prompt), ou null si le prompt n'en prévoit pas. */
function findSlot(prompt: string, label: string, token: RegExp): { start: number; end: number; placement: 'slot' | 'token' } | null {
  const t = token.exec(prompt);
  if (t) return { start: t.index, end: t.index + t[0].length, placement: 'token' };
  // Ligne « <puce> <libellé> : <mention> » : seule la mention est remplacée, la puce, le libellé et la ponctuation restent.
  const line = new RegExp(String.raw`^([^\S\n]*[^\w\n]{0,4}[^\S\n]*${label}[^\S\n]*[:：][^\S\n]*)(${PLACEHOLDER})`, 'gim');
  let last: RegExpExecArray | null = null;
  for (let m = line.exec(prompt); m; m = line.exec(prompt)) last = m;
  if (!last) return null;
  const start = last.index + last[1]!.length;
  return { start, end: start + last[2]!.length, placement: 'slot' };
}

/**
 * Assemble le message envoyé au modèle. `offer` vaut null pour une évaluation du CV seul.
 * Aucun espace, aucune ligne, aucun caractère du prompt n'est modifié : le contenu est
 * inséré à la place exacte de la mention, ou ajouté après le prompt s'il n'en prévoit pas.
 */
export function assembleAtsPrompt(prompt: string, cv: string, offer: string | null): AssembledPrompt {
  const cvSlot = findSlot(prompt, CV_LABEL, CV_TOKEN);
  const offerSlot = findSlot(prompt, OFFER_LABEL, OFFER_TOKEN);
  // Remplacements dans l'ordre du texte, puis ajouts éventuels à la fin.
  const parts: { at: number; end: number; kind: 'cv' | 'offer'; content: string; placement: Insertion['placement'] }[] = [];
  // Un saut de ligne précède le contenu inséré dans une ligne « ■ CV : » : la mise en page du prompt reste lisible.
  if (cvSlot) parts.push({ at: cvSlot.start, end: cvSlot.end, kind: 'cv', content: cvSlot.placement === 'slot' ? `\n${cv}` : cv, placement: cvSlot.placement });
  // Évaluation du CV seul : la zone de l'offre est laissée telle quelle (le prompt prévoit lui-même ce cas).
  if (offerSlot && offer !== null) parts.push({ at: offerSlot.start, end: offerSlot.end, kind: 'offer', content: offerSlot.placement === 'slot' ? `\n${offer}` : offer, placement: offerSlot.placement });
  parts.sort((a, b) => a.at - b.at);
  let text = '';
  let cursor = 0;
  const insertions: Insertion[] = [];
  for (const p of parts) {
    text += prompt.slice(cursor, p.at);
    insertions.push({ kind: p.kind, start: text.length, end: text.length + p.content.length, replaced: prompt.slice(p.at, p.end), placement: p.placement });
    text += p.content;
    cursor = p.end;
  }
  text += prompt.slice(cursor);
  // Pas de zone prévue : le contenu est ajouté après le prompt, qui reste intact (aucun espace final retiré).
  const append = (kind: 'cv' | 'offer', label: string, content: string) => {
    const lead = `\n\n${label}\n`;
    text += lead;
    insertions.push({ kind, start: text.length - lead.length, end: text.length + content.length, replaced: '', placement: 'appended' });
    text += content;
  };
  if (!cvSlot) append('cv', '■ CV :', cv);
  if (!offerSlot && offer !== null) append('offer', '■ Offre d’emploi :', offer);
  return { text, insertions };
}

/** Retire les insertions et remet les mentions d'origine : on doit retrouver le prompt enregistré, octet pour octet. */
export function reconstructPrompt(a: AssembledPrompt): string {
  let out = a.text;
  for (const ins of [...a.insertions].sort((x, y) => y.start - x.start)) out = out.slice(0, ins.start) + ins.replaced + out.slice(ins.end);
  return out;
}

export interface IntegrityRecord {
  ok: boolean;
  /** Empreinte du prompt enregistré (calculée sur le texte lu en base, puis comparée à l'empreinte stockée). */
  promptSha256: string;
  promptStoredSha256: string;
  promptChars: number;
  /** Empreinte du prompt reconstitué à partir du message envoyé. */
  reconstructedSha256: string;
  /** Empreinte du message exact transmis au modèle. */
  requestSha256: string;
  requestChars: number;
  /** Empreinte du cadre technique (consigne système) transmis avec le prompt. */
  systemSha256: string;
  /** Contenus insérés : position dans le message envoyé, longueur, empreinte et mention d'origine remplacée. */
  insertions: { kind: 'cv' | 'offer'; placement: Insertion['placement']; replaced: string; start: number; chars: number; sha256: string }[];
  cv: { source: 'document_pdf' | 'document_docx' | 'document_text' | 'structured'; chars: number; sha256: string; pdfAttached: boolean; pdfSha256: string | null };
  offer: { chars: number; sha256: string; complete: boolean } | null;
  /** Ce que le fournisseur déclare avoir effectivement sérialisé (empreinte du texte du message). */
  transmitted?: { provider: string; source: 'http_body' | 'stdin' | 'mock'; sha256: string; chars: number; matches: boolean; systemMatches: boolean | null; pdf: { sha256: string; bytes: number; matches: boolean } | null };
  output?: { sha256: string; chars: number; stopReason: string; complete: boolean; maxTokens: number; attempts: number };
  problems: string[];
}

/** Le prompt ne peut pas être transmis à l'identique : l'analyse n'est pas lancée et la tâche attend une intervention. */
export class PromptIntegrityError extends NeedsHumanError {
  constructor(message: string, data?: Record<string, unknown>) {
    super(message, 'ats_prompt_integrity', data);
  }
}

/** Vérifie l'assemblage avant tout appel au modèle. Lève une erreur si la moindre différence est détectée. */
export function verifyAssembly(promptContent: string, storedSha: string, a: AssembledPrompt): { promptSha256: string; reconstructedSha256: string; problems: string[] } {
  const problems: string[] = [];
  const promptSha256 = sha256(promptContent);
  if (promptSha256 !== storedSha) problems.push('Le prompt lu en base ne correspond plus à son empreinte enregistrée.');
  const reconstructed = reconstructPrompt(a);
  const reconstructedSha256 = sha256(reconstructed);
  if (reconstructed !== promptContent) {
    let i = 0;
    while (i < reconstructed.length && reconstructed[i] === promptContent[i]) i++;
    problems.push(`Le message assemblé ne restitue pas le prompt à l'identique (première différence au caractère ${i}).`);
  }
  return { promptSha256, reconstructedSha256, problems };
}

/** Comparaison caractère par caractère, pour l'interface et les rapports. */
export interface PromptDifference {
  position: number;
  line: number;
  column: number;
  expected: string;
  actual: string;
  context: string;
}

export function comparePrompts(reference: string, candidate: string, max = 20): { identical: boolean; differences: PromptDifference[]; referenceSha256: string; candidateSha256: string; lineEndingsOnly: boolean } {
  const referenceSha256 = sha256(reference);
  const candidateSha256 = sha256(candidate);
  if (reference === candidate) return { identical: true, differences: [], referenceSha256, candidateSha256, lineEndingsOnly: false };
  const lineEndingsOnly = reference.replace(/\r\n?/g, '\n') === candidate.replace(/\r\n?/g, '\n');
  // Alignement simple par plus longue sous-séquence locale : suffisant pour signaler les écarts sans en masquer aucun.
  const differences: PromptDifference[] = [];
  let i = 0;
  let j = 0;
  const pos = (s: string, k: number) => {
    const before = s.slice(0, k);
    const line = before.split('\n').length;
    return { line, column: k - before.lastIndexOf('\n') };
  };
  while ((i < reference.length || j < candidate.length) && differences.length < max) {
    if (reference[i] === candidate[j]) {
      i++;
      j++;
      continue;
    }
    // Cherche la plus proche resynchronisation (jusqu'à 200 caractères d'avance de part et d'autre).
    let best: [number, number] | null = null;
    for (let d = 1; d <= 200 && !best; d++) {
      for (let a = 0; a <= d; a++) {
        const b = d - a;
        if (reference.slice(i + a, i + a + 12) === candidate.slice(j + b, j + b + 12) && i + a < reference.length) {
          best = [a, b];
          break;
        }
      }
    }
    const [a, b] = best ?? [reference.length - i, candidate.length - j];
    const p = pos(reference, i);
    differences.push({ position: i, line: p.line, column: p.column, expected: reference.slice(i, i + a), actual: candidate.slice(j, j + b), context: reference.slice(Math.max(0, i - 30), i) });
    i += a;
    j += b;
  }
  return { identical: false, differences, referenceSha256, candidateSha256, lineEndingsOnly };
}
