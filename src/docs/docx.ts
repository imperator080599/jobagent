// Manipulation d'un fichier Word (DOCX) au plus près de l'original.
// Le document n'est jamais reconstruit : on travaille sur une copie, et seuls les
// paragraphes à modifier sont réécrits. Tout le reste (styles, marges, polices,
// tabulations, bordures, en-têtes, images) reste identique à l'octet près.
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { type MarkupSpan, parseMarkup } from '../shared/cv.js';

export interface DocxPackage {
  files: Record<string, Uint8Array>;
}

export const DOCUMENT_XML = 'word/document.xml';

export function readDocx(data: Uint8Array): DocxPackage {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data);
  } catch {
    throw new Error("Ce fichier n'est pas un document Word (.docx) valide.");
  }
  if (!files[DOCUMENT_XML]) throw new Error("Ce fichier n'est pas un document Word (.docx) valide : contenu principal introuvable.");
  return { files };
}

export function writeDocx(pkg: DocxPackage): Uint8Array {
  // [Content_Types].xml doit rester en tête d'archive pour certains lecteurs.
  const ordered: Record<string, Uint8Array> = {};
  if (pkg.files['[Content_Types].xml']) ordered['[Content_Types].xml'] = pkg.files['[Content_Types].xml'];
  for (const [k, v] of Object.entries(pkg.files)) if (k !== '[Content_Types].xml') ordered[k] = v;
  return zipSync(ordered, { level: 6 });
}

export function getXml(pkg: DocxPackage, path = DOCUMENT_XML): string {
  const f = pkg.files[path];
  if (!f) throw new Error(`Partie absente du document : ${path}`);
  return strFromU8(f);
}

export function setXml(pkg: DocxPackage, xml: string, path = DOCUMENT_XML): void {
  pkg.files[path] = strToU8(xml);
}

export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

export interface Range {
  start: number;
  end: number;
}

/**
 * Repère tous les paragraphes (<w:p>) du XML, y compris dans les tableaux, mais pas
 * ceux imbriqués dans un autre paragraphe (zones de texte) : ceux-là appartiennent
 * à leur paragraphe parent et ne sont jamais touchés.
 */
export function scanParagraphs(xml: string): Range[] {
  const out: Range[] = [];
  const re = /<w:p(?=[\s>/])[^>]*?(\/)?>|<\/w:p>/g;
  let depth = 0;
  let start = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (m[0].startsWith('</')) {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push({ start, end: m.index + m[0].length });
        start = -1;
      }
    } else if (m[1]) {
      if (depth === 0) out.push({ start: m.index, end: m.index + m[0].length });
    } else {
      if (depth === 0) start = m.index;
      depth++;
    }
  }
  return out;
}

export interface DocxRun {
  /** XML d'origine du segment, pour pouvoir le conserver tel quel. */
  raw: string;
  rPr: string;
  /** Texte du segment ; « \t » pour une tabulation, « \n » pour un saut de ligne. */
  text: string;
  bold: boolean;
  italic: boolean;
}

export interface DocxParagraph {
  xml: string;
  /** Balise ouvrante <w:p …> telle quelle. */
  open: string;
  /** Bloc <w:pPr>…</w:pPr> tel quel (style, alignement, retraits, tabulations, bordures). */
  pPr: string;
  runs: DocxRun[];
  text: string;
  /** Contient des éléments qu'une réécriture du texte ferait perdre (liens, champs, images). */
  complex: boolean;
  /** Paragraphe à puce ou numéroté (numérotation Word ou puce saisie). */
  listItem: boolean;
}

const isOn = (rPr: string, tag: string) => {
  const m = new RegExp(`<w:${tag}(\\s[^>]*)?/>`).exec(rPr);
  if (!m) return false;
  return !/w:val="(0|false|off)"/.test(m[1] ?? '');
};

function runText(inner: string): string {
  let out = '';
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:t(?:\s[^>]*)?\/>|<w:tab(?:\s[^>]*)?\/>|<w:br(?:\s[^>]*)?\/>|<w:cr(?:\s[^>]*)?\/>|<w:noBreakHyphen\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner))) {
    if (m[0].startsWith('<w:tab')) out += '\t';
    else if (m[0].startsWith('<w:br') || m[0].startsWith('<w:cr')) out += /w:type="(page|column)"/.test(m[0]) ? '' : '\n';
    else if (m[0].startsWith('<w:noBreakHyphen')) out += '‑';
    else out += unescapeXml(m[1] ?? '');
  }
  return out;
}

export function parseParagraph(xml: string): DocxParagraph {
  const open = /^<w:p(?=[\s>/])[^>]*>/.exec(xml)?.[0] ?? '<w:p>';
  const selfClosed = open.endsWith('/>');
  const pPr = /<w:pPr>[\s\S]*?<\/w:pPr>|<w:pPr\/>/.exec(xml)?.[0] ?? '';
  const runs: DocxRun[] = [];
  if (!selfClosed) {
    const body = xml.slice(open.length).replace(pPr, '');
    const re = /<w:r(?=[\s>])[^>]*>([\s\S]*?)<\/w:r>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
      const inner = m[1]!;
      const rPr = /<w:rPr>[\s\S]*?<\/w:rPr>|<w:rPr\/>/.exec(inner)?.[0] ?? '';
      const text = runText(inner.replace(rPr, ''));
      if (text === '') continue;
      runs.push({ raw: m[0], rPr: rPr === '<w:rPr/>' ? '' : rPr, text, bold: isOn(rPr, 'b'), italic: isOn(rPr, 'i') });
    }
  }
  const text = runs.map((r) => r.text).join('');
  const complex = /<w:hyperlink|<w:fldSimple|<w:fldChar|<w:drawing|<w:pict|<w:object|<mc:AlternateContent|<w:ins[\s>]|<w:del[\s>]/.test(xml);
  const listItem = /<w:numPr>/.test(pPr) || /^\s*[•◦▪■●○·‣∙➢►▸–-]\s/.test(text);
  return { xml, open: selfClosed ? open.replace(/\/>$/, '>') : open, pPr: pPr === '<w:pPr/>' ? '' : pPr, runs, text, complex, listItem };
}

/** Texte du paragraphe avec sa mise en valeur d'origine (**gras**, *italique*). */
export function paragraphToMarked(p: DocxParagraph): string {
  // Fusionne les segments contigus de même mise en forme avant de baliser.
  const merged: { text: string; bold: boolean; italic: boolean }[] = [];
  for (const r of p.runs) {
    const last = merged[merged.length - 1];
    if (last && last.bold === r.bold && last.italic === r.italic) last.text += r.text;
    else merged.push({ text: r.text, bold: r.bold, italic: r.italic });
  }
  const allSame = merged.length <= 1;
  return merged
    .map((s) => {
      if (allSame || (!s.bold && !s.italic) || !s.text.trim()) return s.text;
      // Les espaces et tabulations en bordure restent hors des balises.
      const lead = /^[\s]*/.exec(s.text)![0];
      const trail = /[\s]*$/.exec(s.text)![0];
      const core = s.text.slice(lead.length, s.text.length - trail.length);
      const mark = s.bold && s.italic ? '***' : s.bold ? '**' : '*';
      // Une balise ne traverse pas une tabulation : chaque segment est balisé séparément.
      return lead + core.split('\t').map((part) => (part.trim() ? `${mark}${part}${mark}` : part)).join('\t') + trail;
    })
    .join('');
}

function withFlag(rPr: string, tag: 'b' | 'i', on: boolean): string {
  const inner = rPr.replace(/^<w:rPr>|<\/w:rPr>$/g, '');
  const cleaned = inner.replace(new RegExp(`<w:${tag}(\\s[^>]*)?/>`, 'g'), '').replace(new RegExp(`<w:${tag}Cs(\\s[^>]*)?/>`, 'g'), '');
  if (!on) return cleaned ? `<w:rPr>${cleaned}</w:rPr>` : '';
  // L'ordre des propriétés suit le schéma Word : style et police d'abord, puis gras/italique.
  const head = /^(?:<w:rStyle[^>]*\/>)?(?:<w:rFonts[^>]*\/>)?/.exec(cleaned)![0];
  return `<w:rPr>${head}<w:${tag}/><w:${tag}Cs/>${cleaned.slice(head.length)}</w:rPr>`;
}

function runXml(rPr: string, text: string): string {
  let out = '';
  for (const part of text.split(/(\t|\n)/)) {
    if (part === '') continue;
    if (part === '\t') out += `<w:r>${rPr}<w:tab/></w:r>`;
    else if (part === '\n') out += `<w:r>${rPr}<w:br/></w:r>`;
    else out += `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(part)}</w:t></w:r>`;
  }
  return out;
}

/**
 * Réécrit le texte d'un paragraphe en conservant sa mise en forme : style de
 * paragraphe intact, et pour chaque segment la police/taille/couleur d'un segment
 * d'origine de même nature (normal, gras, italique).
 * Si le nouveau texte ne porte aucune mise en valeur, la mise en forme dominante
 * du paragraphe d'origine s'applique à l'ensemble.
 */
export function rewriteParagraph(base: DocxParagraph, marked: string, opts: { keepPrefix?: number } = {}): string {
  // Préfixe à conserver tel quel (puce et tabulation saisies) : ses segments d'origine sont recopiés à l'identique.
  let prefixXml = '';
  let body = base.runs;
  if (opts.keepPrefix) {
    let consumed = 0;
    let k = 0;
    while (k < base.runs.length && consumed + base.runs[k]!.text.length <= opts.keepPrefix) consumed += base.runs[k++]!.text.length;
    if (consumed === opts.keepPrefix) {
      prefixXml = base.runs.slice(0, k).map((r) => r.raw).join('');
      body = base.runs.slice(k);
    } else marked = base.text.slice(0, opts.keepPrefix) + marked;
  }
  const spans: MarkupSpan[] = parseMarkup(marked);
  // Pour chaque nature de segment (normal, gras, italique), le segment d'origine le plus long sert de modèle.
  const weight = new Map<string, { chars: number; best: number; rPr: string }>();
  for (const r of body.length ? body : base.runs) {
    const key = `${r.bold ? 1 : 0}${r.italic ? 1 : 0}`;
    const chars = r.text.replace(/\s/g, '').length;
    const g = weight.get(key) ?? { chars: 0, best: -1, rPr: r.rPr };
    g.chars += chars;
    if (chars > g.best) {
      g.best = chars;
      g.rPr = r.rPr;
    }
    weight.set(key, g);
  }
  const dominantKey = [...weight.entries()].sort((a, b) => b[1].chars - a[1].chars)[0]?.[0] ?? '00';
  const dominant = weight.get(dominantKey)?.rPr ?? '';
  const proto = (bold: boolean, italic: boolean): string => {
    const exact = weight.get(`${bold ? 1 : 0}${italic ? 1 : 0}`);
    if (exact) return exact.rPr;
    return withFlag(withFlag(dominant, 'b', bold), 'i', italic);
  };
  const plainOnly = spans.every((s) => !s.bold && !s.italic);
  let runs = '';
  for (const s of spans) runs += runXml(plainOnly ? dominant : proto(s.bold, s.italic), s.text);
  return `${base.open}${base.pPr}${prefixXml}${runs}</w:p>`;
}

export interface Edit extends Range {
  replacement: string;
}

/** Applique des modifications disjointes au XML (suppressions, remplacements, insertions). */
export function applyEdits(xml: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = xml;
  let guard = Infinity;
  for (const e of sorted) {
    if (e.end > guard) throw new Error('Modifications du document qui se chevauchent.');
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
    guard = e.start;
  }
  return out;
}

export interface DocumentParagraphs {
  xml: string;
  ranges: Range[];
  paragraphs: DocxParagraph[];
}

export function readParagraphs(xml: string): DocumentParagraphs {
  const ranges = scanParagraphs(xml);
  return { xml, ranges, paragraphs: ranges.map((r) => parseParagraph(xml.slice(r.start, r.end))) };
}

/** Marges et format de page (en points) lus dans la dernière section du document. */
export function pageGeometry(xml: string): { width: number; height: number; top: number; bottom: number; left: number; right: number } | null {
  const sect = [...xml.matchAll(/<w:sectPr[\s\S]*?<\/w:sectPr>/g)].pop()?.[0];
  if (!sect) return null;
  const attr = (tag: string, name: string) => {
    const m = new RegExp(`<w:${tag}[^>]*\\sw:${name}="(-?\\d+)"`).exec(sect);
    return m ? Number(m[1]) / 20 : 0;
  };
  return { width: attr('pgSz', 'w') || 595.3, height: attr('pgSz', 'h') || 841.9, top: attr('pgMar', 'top'), bottom: attr('pgMar', 'bottom'), left: attr('pgMar', 'left'), right: attr('pgMar', 'right') };
}

/** Polices déclarées dans le document (pour vérifier le rendu final). */
export function declaredFonts(pkg: DocxPackage): string[] {
  const fonts = new Set<string>();
  for (const path of [DOCUMENT_XML, 'word/styles.xml']) {
    const f = pkg.files[path];
    if (!f) continue;
    for (const m of strFromU8(f).matchAll(/w:(?:ascii|hAnsi)="([^"]+)"/g)) fonts.add(m[1]!);
  }
  return [...fonts];
}
