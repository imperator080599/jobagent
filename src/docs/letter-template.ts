// Modèle de lettre de motivation : analyse d'un template Word à zones entre
// crochets ([Your name], [Introduction]…), puis remplissage d'une copie du template.
// La présentation (polices, marges, alignements, espacements) n'est jamais recréée :
// seuls les textes des zones sont remplacés.
import { strFromU8, strToU8 } from 'fflate';
import { detectLanguage, normalize, slugify } from '../core/text.js';
import { DOCUMENT_XML, type DocxPackage, type Edit, applyEdits, declaredFonts, getXml, pageGeometry, readParagraphs, rewriteParagraph, setXml } from './docx.js';

export type LetterField =
  | 'sender.name' | 'sender.address' | 'sender.phone' | 'sender.email' | 'sender.linkedin'
  | 'recipient.name' | 'recipient.title' | 'recipient.company' | 'recipient.address'
  | 'date' | 'subject' | 'signature';

export interface LetterParagraphRole {
  index: number;
  role: 'field' | 'section' | 'guidance' | 'salutation' | 'closing' | 'spacer' | 'static';
  field?: LetterField;
  section?: string;
}

export interface LetterTemplateProfile {
  kind: 'letter';
  language: string;
  paragraphs: LetterParagraphRole[];
  /** Structure du corps de la lettre voulue par le template, avec ses propres consignes. */
  sections: { key: string; label: string; brief: string }[];
  closingText: string;
  /** Mentions du fournisseur du modèle (publicité, copyright) en pied de page : retirées des lettres. */
  vendorFooters: { path: string; text: string }[];
  /** Zones entre crochets non reconnues : signalées à l'utilisateur, laissées telles quelles. */
  unknownPlaceholders: string[];
  fonts: string[];
  page: ReturnType<typeof pageGeometry>;
}

const PLACEHOLDER = /\[([^[\]]{1,80})\]/g;
const SALUTATION = /^(dear|madame|monsieur|bonjour|cher|chère|estimad|sehr geehrt|to whom)/i;
const CLOSING = /(sincerely|faithfully|regards|cordialement|salutations|veuillez agr[ée]er|prie d'agr[ée]er|atentamente|freundlichen gr[üu][ßs]en)/i;
const VENDOR = /(copyright|©|sign up|subscribe|template by|mod[èe]le fourni|www\.|https?:|\.(com|io|co|net|org)\b)/i;

function classify(label: string): LetterField | null {
  const n = normalize(label);
  const recruiterSide = /\b(recruiter|recruteur|recruteuse|hiring|manager|destinataire|contact|employer|employeur)\b/.test(n);
  const companySide = /\b(office|company|entreprise|societe|cabinet|firm|organisation|organization|employer|employeur)\b/.test(n);
  if (/\b(e ?mail|courriel|mail)\b/.test(n)) return 'sender.email';
  if (/\b(phone|telephone|tel|mobile|portable)\b/.test(n)) return 'sender.phone';
  if (/\blinkedin\b/.test(n)) return 'sender.linkedin';
  if (/\b(signature)\b/.test(n)) return 'signature';
  if (/\b(date)\b/.test(n)) return 'date';
  if (/\b(objet|subject|reference|ref)\b/.test(n)) return 'subject';
  if (/\b(position|fonction|title|titre|poste)\b/.test(n) && recruiterSide) return 'recipient.title';
  if (/\b(address|adresse)\b/.test(n)) return companySide || recruiterSide ? 'recipient.address' : 'sender.address';
  if (/\b(name|nom|prenom)\b/.test(n)) {
    if (recruiterSide) return 'recipient.name';
    if (companySide) return 'recipient.company';
    return 'sender.name';
  }
  if (companySide && n.split(' ').length <= 4) return 'recipient.company';
  return null;
}

export function analyzeLetterTemplate(pkg: DocxPackage): LetterTemplateProfile {
  const xml = getXml(pkg);
  const { paragraphs } = readParagraphs(xml);
  const roles: LetterParagraphRole[] = [];
  const sections: LetterTemplateProfile['sections'] = [];
  const unknown: string[] = [];
  let closingText = '';
  let lastSection: string | null = null;

  paragraphs.forEach((p, index) => {
    const text = p.text.replace(/\s+/g, ' ').trim();
    if (!text) {
      roles.push({ index, role: 'spacer' });
      return;
    }
    const placeholders = [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!.trim());
    const onlyPlaceholder = placeholders.length === 1 && text.replace(PLACEHOLDER, '').trim() === '';
    const allItalic = p.runs.length > 0 && p.runs.filter((r) => r.text.trim()).every((r) => r.italic);

    if (onlyPlaceholder) {
      const field = classify(placeholders[0]!);
      if (field) {
        roles.push({ index, role: 'field', field });
        lastSection = null;
      } else {
        const key = slugify(placeholders[0]!) || `section-${sections.length + 1}`;
        sections.push({ key, label: placeholders[0]!.replace(/[?:]\s*$/, '').trim(), brief: '' });
        roles.push({ index, role: 'section', section: key });
        lastSection = key;
      }
      return;
    }
    if (placeholders.length === 0 && allItalic && lastSection) {
      // Consigne du modèle pour la rubrique précédente : elle guide la rédaction, puis disparaît de la lettre.
      const s = sections.find((x) => x.key === lastSection)!;
      s.brief = [s.brief, text].filter(Boolean).join(' ');
      roles.push({ index, role: 'guidance', section: lastSection });
      return;
    }
    if (SALUTATION.test(text) && text.length < 120) {
      roles.push({ index, role: 'salutation' });
      lastSection = null;
      return;
    }
    if (placeholders.length === 0 && CLOSING.test(text) && text.length < 160) {
      closingText = text;
      roles.push({ index, role: 'closing' });
      lastSection = null;
      return;
    }
    for (const ph of placeholders) if (!classify(ph)) unknown.push(ph);
    roles.push({ index, role: 'static' });
  });

  const vendorFooters: LetterTemplateProfile['vendorFooters'] = [];
  for (const [path, bytes] of Object.entries(pkg.files)) {
    if (!/^word\/(footer|header)\d*\.xml$/.test(path)) continue;
    const text = readParagraphs(strFromU8(bytes)).paragraphs.map((p) => p.text).join(' ').replace(/\s+/g, ' ').trim();
    if (text && VENDOR.test(text)) vendorFooters.push({ path, text });
  }

  const staticText = paragraphs.filter((_, i) => ['static', 'salutation', 'closing', 'guidance'].includes(roles[i]!.role)).map((p) => p.text).join(' ');
  return {
    kind: 'letter',
    language: detectLanguage(staticText) || (/(sincerely|dear|regards)/i.test(staticText) ? 'en' : 'fr'),
    paragraphs: roles,
    sections,
    closingText,
    vendorFooters,
    unknownPlaceholders: [...new Set(unknown)],
    fonts: declaredFonts(pkg),
    page: pageGeometry(xml),
  };
}

export interface LetterContent {
  sender: { name: string; address?: string; phone?: string; email?: string; linkedin?: string };
  recipient: { name?: string; title?: string; company?: string; address?: string };
  date: string;
  subject?: string;
  salutation: string;
  /** Paragraphes de chaque rubrique du corps, dans l'ordre des rubriques du template. */
  sections: Record<string, string[]>;
  closing: string;
  signature: string;
}

function fieldValue(c: LetterContent, f: LetterField): string {
  switch (f) {
    case 'sender.name': return c.sender.name;
    case 'sender.address': return c.sender.address ?? '';
    case 'sender.phone': return c.sender.phone ?? '';
    case 'sender.email': return c.sender.email ?? '';
    case 'sender.linkedin': return c.sender.linkedin ?? '';
    case 'recipient.name': return c.recipient.name ?? '';
    case 'recipient.title': return c.recipient.title ?? '';
    case 'recipient.company': return c.recipient.company ?? '';
    case 'recipient.address': return c.recipient.address ?? '';
    case 'date': return c.date;
    case 'subject': return c.subject ?? '';
    case 'signature': return c.signature;
  }
}

/** Remplit une copie du template. Une zone sans valeur est retirée : rien n'est laissé entre crochets, rien n'est inventé. */
export function renderLetter(template: DocxPackage, profile: LetterTemplateProfile, content: LetterContent, opts: { keepVendorFooter?: boolean } = {}): DocxPackage {
  const pkg: DocxPackage = { files: { ...template.files } };
  const xml = getXml(pkg);
  const doc = readParagraphs(xml);
  const edits: Edit[] = [];
  const removed = new Set<number>();
  const remove = (i: number) => {
    if (removed.has(i) || !doc.ranges[i]) return;
    removed.add(i);
    edits.push({ ...doc.ranges[i]!, replacement: '' });
  };
  const rewrite = (i: number, text: string) => edits.push({ ...doc.ranges[i]!, replacement: rewriteParagraph(doc.paragraphs[i]!, text) });
  const roleAt = (i: number) => profile.paragraphs[i]?.role;

  for (const r of profile.paragraphs) {
    const i = r.index;
    if (r.role === 'field') {
      const value = fieldValue(content, r.field!).trim();
      if (value) rewrite(i, value);
      else remove(i);
    } else if (r.role === 'salutation') rewrite(i, content.salutation);
    else if (r.role === 'closing') rewrite(i, content.closing);
    else if (r.role === 'guidance') {
      remove(i);
      // Un seul interligne doit subsister entre deux rubriques : si la consigne était encadrée de deux
      // interlignes, on retire celui qui la précédait ; si elle portait elle-même le saut de ligne, on le garde.
      if (roleAt(i - 1) === 'spacer' && roleAt(i + 1) === 'spacer') remove(i - 1);
    } else if (r.role === 'section') {
      const paras = (content.sections[r.section!] ?? []).map((t) => t.trim()).filter(Boolean);
      if (!paras.length) {
        remove(i);
        if (roleAt(i + 1) === 'spacer') remove(i + 1);
        continue;
      }
      const base = doc.paragraphs[i]!;
      // Plusieurs paragraphes dans une rubrique : chacun reprend la forme du paragraphe du template, séparé par le même interligne.
      const spacerIndex = profile.paragraphs.find((x) => x.role === 'spacer')?.index;
      const spacer = spacerIndex !== undefined ? doc.paragraphs[spacerIndex]!.xml : '';
      edits.push({ ...doc.ranges[i]!, replacement: paras.map((t) => rewriteParagraph(base, t)).join(spacer) });
    }
  }

  // Bloc destinataire entièrement vide : on retire aussi l'interligne qui le suivait.
  const recipientIdx = profile.paragraphs.filter((r) => r.role === 'field' && r.field!.startsWith('recipient.')).map((r) => r.index);
  if (recipientIdx.length && recipientIdx.every((i) => removed.has(i))) {
    const after = Math.max(...recipientIdx) + 1;
    if (roleAt(after) === 'spacer') remove(after);
  }

  setXml(pkg, applyEdits(xml, edits));

  if (!opts.keepVendorFooter) {
    for (const f of profile.vendorFooters) {
      const part = strFromU8(pkg.files[f.path]!);
      const fd = readParagraphs(part);
      pkg.files[f.path] = strToU8(applyEdits(part, fd.ranges.map((range, k) => ({ ...range, replacement: `${fd.paragraphs[k]!.open}${fd.paragraphs[k]!.pPr}</w:p>` }))));
    }
  }
  return pkg;
}

export { DOCUMENT_XML };
