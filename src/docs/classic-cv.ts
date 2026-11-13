// Génère un CV Word au format « classique finance » (une colonne, titres centrés
// soulignés d'un filet, entreprise à gauche et lieu à droite, puces à retrait).
// Deux usages :
//  - constituer un document de travail Word quand l'utilisateur n'a fourni qu'un PDF
//    (les dimensions par défaut reprennent celles mesurées sur ce type de CV) ;
//  - servir de modèle par défaut.
// Une fois ce document créé, il est traité comme n'importe quel template Word :
// les CV personnalisés sont des copies dont seuls les paragraphes utiles changent.
import { AlignmentType, BorderStyle, Document, ExternalHyperlink, LineRuleType, Packer, Paragraph, TabStopType, TextRun } from 'docx';
import { type Bullet, type CvData, fmtDate, normalizeMarkup, parseMarkup } from '../shared/cv.js';

export interface ClassicStyle {
  font: string;
  /** Taille du texte courant, en points. */
  size: number;
  nameSize: number;
  /** Marges de page, en points. */
  margins: { top: number; bottom: number; left: number; right: number };
  /** Retrait du texte des puces et position de la puce, en points. */
  bulletIndent: number;
  bulletHanging: number;
  /** Retraits latéraux de l'accroche, en points. */
  summaryIndent: number;
  /** Espace avant un titre de rubrique, en points. */
  sectionSpacing: number;
  /** Position de la tabulation de droite (lieux et dates), en points depuis le bord gauche de la page. */
  rightTab: number;
  linkColor: string;
  /** Interligne, en 240e de ligne (240 = simple). */
  line?: number;
}

/** Dimensions mesurées sur un CV d'une page au format classique (Calibri 10 pt). */
export const DEFAULT_CLASSIC_STYLE: ClassicStyle = {
  font: 'Calibri',
  size: 10,
  nameSize: 16,
  margins: { top: 28, bottom: 30, left: 50, right: 36 },
  bulletIndent: 20,
  bulletHanging: 18,
  summaryIndent: 14,
  sectionSpacing: 11,
  rightTab: 546,
  linkColor: '0563C1',
};

/** Version du générateur : un document de travail constitué par une version antérieure est reconstruit. */
export const CLASSIC_BUILDER_VERSION = 3;

/**
 * Réglages de plus en plus serrés, essayés dans l'ordre lorsque le document constitué
 * dépasse la pagination du CV d'origine. La taille des caractères n'est réduite qu'en
 * dernier recours, et jamais sous 9,5 pt.
 */
export const FIT_STEPS: Partial<ClassicStyle>[] = [
  {},
  { sectionSpacing: 8 },
  { sectionSpacing: 7, margins: { top: 24, bottom: 24, left: 50, right: 36 } },
  { sectionSpacing: 6, margins: { top: 22, bottom: 22, left: 46, right: 34 }, rightTab: 600 },
  { sectionSpacing: 5, margins: { top: 20, bottom: 20, left: 42, right: 32 }, rightTab: 600, line: 232 },
  { sectionSpacing: 5, margins: { top: 20, bottom: 20, left: 42, right: 32 }, rightTab: 600, line: 232, size: 9.5 },
];

const tw = (pt: number) => Math.round(pt * 20);

const LABELS: Record<string, { phone: string; email: string; linkedin: string; present: string; languages: string }> = {
  fr: { phone: 'Téléphone', email: 'Email', linkedin: 'LinkedIn', present: "Aujourd'hui", languages: 'Langues' },
  en: { phone: 'Phone', email: 'Email', linkedin: 'Linkedin', present: 'Present', languages: 'Languages' },
  es: { phone: 'Teléfono', email: 'Email', linkedin: 'LinkedIn', present: 'Actualidad', languages: 'Idiomas' },
  de: { phone: 'Telefon', email: 'E-Mail', linkedin: 'LinkedIn', present: 'Heute', languages: 'Sprachen' },
};

const DEFAULT_TITLES: Record<string, Record<string, string>> = {
  fr: { experiences: 'EXPÉRIENCES PROFESSIONNELLES', education: 'FORMATION', skills: 'COMPÉTENCES', languages: 'LANGUES', certifications: 'CERTIFICATIONS' },
  en: { experiences: 'WORK EXPERIENCE', education: 'EDUCATION', skills: 'SKILLS', languages: 'LANGUAGES', certifications: 'CERTIFICATIONS' },
};

export async function buildClassicCv(cv: CvData, style: ClassicStyle = DEFAULT_CLASSIC_STYLE): Promise<Uint8Array> {
  const L = LABELS[cv.language] ?? LABELS.en!;
  const titles = { ...(DEFAULT_TITLES[cv.language] ?? DEFAULT_TITLES.en!), ...cv.titles };
  const half = style.size * 2;
  const textWidth = 595.3 - style.margins.left - style.margins.right;
  const rightTab = [{ type: TabStopType.RIGHT, position: tw(Math.min(textWidth, style.rightTab - style.margins.left)) }];
  const line = { line: style.line ?? 240, lineRule: LineRuleType.AUTO, before: 0, after: 0 };

  const runs = (marked: string, base: { bold?: boolean; italics?: boolean } = {}) =>
    parseMarkup(normalizeMarkup(marked)).map((s) => new TextRun({ text: s.text, font: style.font, size: half, bold: base.bold || s.bold || undefined, italics: base.italics || s.italic || undefined }));
  const plain = (text: string, o: { bold?: boolean; size?: number } = {}) => new TextRun({ text, font: style.font, size: (o.size ?? style.size) * 2, bold: o.bold || undefined });
  const period = (e: { start: string; end: string; dates?: string }) => e.dates || [fmtDate(e.start, cv.language), e.end === 'present' ? L.present : fmtDate(e.end, cv.language)].filter(Boolean).join(' – ');

  const out: Paragraph[] = [];
  const centered = (children: (TextRun | ExternalHyperlink)[], extra: { before?: number } = {}) => out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { ...line, before: tw(extra.before ?? 0) }, children }));
  const link = (text: string, url: string) => new ExternalHyperlink({ link: url, children: [new TextRun({ text, font: style.font, size: half, color: style.linkColor, underline: {} })] });
  const item = (b: Bullet) => {
    if (b.kind === 'text') out.push(new Paragraph({ spacing: line, children: runs(b.text) }));
    else out.push(new Paragraph({ spacing: line, indent: { left: tw(style.bulletIndent), hanging: tw(style.bulletHanging) }, tabStops: [{ type: TabStopType.LEFT, position: tw(style.bulletIndent) }], children: [plain('•\t'), ...runs(b.text)] }));
  };
  const heading = (title: string) =>
    out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { ...line, before: tw(style.sectionSpacing) }, border: { top: { style: BorderStyle.SINGLE, size: 6, color: '000000', space: 1 } }, children: [plain(title, { bold: true })] }));
  const twoSided = (left: string, right: string, opts: { leftBold?: boolean } = {}) =>
    out.push(new Paragraph({ spacing: line, tabStops: rightTab, children: [plain(left, { bold: opts.leftBold ?? true }), ...(right ? [plain(`\t${right}`)] : [])] }));

  // ── En-tête ──
  const id = cv.identity;
  centered([plain(id.fullName, { size: style.nameSize })]);
  const contact: (TextRun | ExternalHyperlink)[] = [];
  if (id.phone) contact.push(plain(`${L.phone}: ${id.phone}`));
  if (id.email) contact.push(plain(`${contact.length ? ' - ' : ''}${L.email}: `), link(id.email, `mailto:${id.email}`));
  if (id.location) contact.push(plain(`${contact.length ? ' - ' : ''}${id.location}`));
  if (contact.length) centered(contact);
  if (id.linkedin) centered([plain(`${L.linkedin}: `), link(id.linkedin, /^https?:/.test(id.linkedin) ? id.linkedin : `https://${id.linkedin}`)]);
  if (id.headline) centered(runs(id.headline));

  // ── Rubriques, dans l'ordre du CV ──
  for (const section of cv.sectionOrder) {
    if (section === 'summary' && cv.summary) {
      out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { ...line, before: tw(style.sectionSpacing) }, indent: { left: tw(style.summaryIndent), right: tw(style.summaryIndent) }, children: runs(cv.summary, { bold: true }) }));
    }
    if (section === 'experiences' && cv.experiences.length) {
      heading(titles.experiences!);
      for (const e of cv.experiences) {
        twoSided(e.company, e.location ?? '');
        twoSided(e.title, period(e));
        if (e.summary) out.push(new Paragraph({ spacing: line, children: runs(e.summary) }));
        e.bullets.forEach(item);
      }
    }
    if (section === 'education' && cv.education.length) {
      heading(titles.education!);
      for (const e of cv.education) {
        const degree = [e.degree, e.field].filter(Boolean).join(', ');
        if (degree) {
          twoSided(e.school, e.location ?? '');
          twoSided(degree, period(e));
        } else twoSided(e.school, period(e));
        e.details.forEach(item);
      }
    }
    if (section === 'skills' && cv.skills.length) {
      heading(titles.skills!);
      for (const g of cv.skills) item({ id: g.id, text: `${g.label ? `**${g.label}** : ` : ''}${g.items.join(', ')}` });
    }
    if (section === 'languages' && cv.languages.length) {
      heading(titles.languages!);
      for (const l of cv.languages) item({ id: l.id, text: `**${l.language}**${l.level ? ` : ${l.level}` : ''}${l.certification ? ` (${l.certification})` : ''}` });
    }
    if (section === 'certifications' && cv.certifications.length) {
      heading(titles.certifications!);
      for (const c of cv.certifications) item({ id: c.id, text: `${c.issuer ? `**${c.issuer}** — ` : ''}${c.name}${c.date ? ` (${c.date})` : ''}` });
    }
    if (section === 'extras') {
      for (const x of cv.extras) {
        if (!x.items.length) continue;
        heading(x.title);
        x.items.forEach(item);
      }
    }
  }

  const doc = new Document({
    creator: cv.identity.fullName,
    title: `CV ${cv.identity.fullName}`,
    styles: { default: { document: { run: { font: style.font, size: half } } } },
    sections: [
      {
        properties: { page: { size: { width: tw(595.3), height: tw(841.9) }, margin: { top: tw(style.margins.top), bottom: tw(style.margins.bottom), left: tw(style.margins.left), right: tw(style.margins.right) } } },
        children: out,
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}
