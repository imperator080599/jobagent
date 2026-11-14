// Extraction du texte d'un document importé (PDF, DOCX, texte). Le fichier
// d'origine est toujours conservé tel quel ; le texte sert à la structuration.
import { compactWhitespace } from '../core/text.js';
import { badRequest } from '../core/errors.js';

export interface ExtractedDocument {
  kind: 'pdf' | 'docx' | 'text';
  text: string;
  /** Même texte, avec la mise en valeur partielle du document balisée (**gras**, *italique*). */
  marked: string;
  pages: number;
  warnings: string[];
}

export function sniffKind(filename: string, mime: string, data: Uint8Array): 'pdf' | 'docx' | 'text' | null {
  const head = Buffer.from(data.subarray(0, 5)).toString('latin1');
  if (head.startsWith('%PDF-')) return 'pdf';
  if (data[0] === 0x50 && data[1] === 0x4b) return /\.docx$/i.test(filename) || mime.includes('wordprocessingml') ? 'docx' : null;
  if (/\.(txt|md)$/i.test(filename) || mime.startsWith('text/')) return 'text';
  return null;
}

interface Item {
  str: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  bold?: boolean;
  italic?: boolean;
}

/**
 * Reconstruit l'ordre de lecture d'une page : regroupe les fragments en lignes et,
 * si une gouttière verticale sépare deux colonnes, lit chaque colonne séparément
 * (les CV en deux colonnes seraient sinon entremêlés ligne à ligne).
 * Avec `markup`, la mise en valeur partielle d'une ligne est balisée (**gras**, *italique*).
 */
export function pageToText(items: Item[], opts: { markup?: boolean } = {}): string {
  const clean = items.filter((i) => i.str.trim().length > 0);
  if (!clean.length) return '';
  const minX = Math.min(...clean.map((i) => i.x));
  const maxX = Math.max(...clean.map((i) => i.x + i.width));
  const width = maxX - minX || 1;

  // Recherche d'une gouttière : bande verticale vide entre 22 % et 72 % de la largeur.
  const bins = 120;
  const occupied = new Array<number>(bins).fill(0);
  for (const it of clean) {
    const a = Math.max(0, Math.floor(((it.x - minX) / width) * bins));
    const b = Math.min(bins - 1, Math.floor(((it.x + it.width - minX) / width) * bins));
    for (let k = a; k <= b; k++) occupied[k]!++;
  }
  let gutter: number | null = null;
  let best = 0;
  let run = 0;
  for (let k = Math.floor(bins * 0.22); k <= Math.floor(bins * 0.72); k++) {
    if (occupied[k]! <= Math.max(1, clean.length * 0.01)) {
      run++;
      if (run > best) {
        best = run;
        gutter = minX + ((k - run / 2 + 0.5) / bins) * width;
      }
    } else run = 0;
  }
  // Deux colonnes seulement si chacune porte plusieurs lignes : une simple tabulation sur une ligne n'est pas une gouttière.
  const linesOn = (side: Item[]) => new Set(side.map((i) => Math.round(i.y / 3))).size;
  const rightSide = gutter !== null ? clean.filter((i) => i.x > gutter!) : [];
  const leftSide = gutter !== null ? clean.filter((i) => i.x + i.width < gutter!) : [];
  const hasColumns = gutter !== null && best >= 3 && rightSide.length > clean.length * 0.15 && leftSide.length > clean.length * 0.15 && linesOn(rightSide) >= 4 && linesOn(leftSide) >= 4;

  const toLines = (list: Item[]): string[] => {
    const sorted = [...list].sort((a, b) => b.y - a.y || a.x - b.x);
    const lines: Item[][] = [];
    for (const it of sorted) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last[0]!.y - it.y) <= Math.max(2, it.fontSize * 0.35)) last.push(it);
      else lines.push([it]);
    }
    return lines.map((line) => {
      line.sort((a, b) => a.x - b.x);
      // Segments de la ligne, avec leur séparateur : espace simple, ou large blanc (tabulation).
      const parts: { text: string; sep: string; bold: boolean; italic: boolean }[] = [];
      let prevEnd: number | null = null;
      let pending = '';
      for (const it of line) {
        if (!it.str.trim()) {
          // Fragment d'espacement explicite du PDF : espace entre deux mots, ou tabulation s'il est large.
          if (prevEnd !== null) pending = it.width > it.fontSize * 2.2 ? '    ' : pending || ' ';
          prevEnd = Math.max(prevEnd ?? 0, it.x + it.width);
          continue;
        }
        let sep = pending;
        if (prevEnd !== null && !sep) {
          const gap = it.x - prevEnd;
          if (gap > it.fontSize * 2.2) sep = '    ';
          else if (gap > it.fontSize * 0.15) sep = ' ';
        }
        if (/^\s/.test(it.str) || (parts.length && /\s$/.test(parts[parts.length - 1]!.text) && sep === ' ')) sep = sep === '    ' ? sep : '';
        parts.push({ text: it.str, sep: parts.length ? sep : '', bold: Boolean(it.bold), italic: Boolean(it.italic) });
        pending = '';
        prevEnd = it.x + it.width;
      }
      const uniform = parts.every((p) => p.bold === parts[0]!.bold && p.italic === parts[0]!.italic);
      if (!opts.markup || uniform) return parts.map((p) => p.sep + p.text).join('').trimEnd();
      // Regroupe les fragments contigus de même style, puis balise les groupes mis en valeur.
      const groups: { text: string; sep: string; bold: boolean; italic: boolean }[] = [];
      for (const p of parts) {
        const g = groups[groups.length - 1];
        if (g && g.bold === p.bold && g.italic === p.italic && p.sep !== '    ') g.text += p.sep + p.text;
        else groups.push({ ...p });
      }
      return groups
        .map((g) => {
          const mark = g.bold && g.italic ? '***' : g.bold ? '**' : g.italic ? '*' : '';
          const core = g.text.trim();
          if (!mark || !core) return g.sep + g.text;
          return `${g.sep}${g.text.match(/^\s*/)![0]}${mark}${core}${mark}${g.text.match(/\s*$/)![0]}`;
        })
        .join('')
        .trimEnd();
    });
  };

  if (!hasColumns) return toLines(items).join('\n');
  const left = items.filter((i) => i.x + i.width / 2 < gutter!);
  const right = items.filter((i) => i.x + i.width / 2 >= gutter!);
  // La colonne la plus large porte généralement le contenu principal : on la lit en premier.
  const [first, second] = right.filter((i) => i.str.trim()).length >= left.filter((i) => i.str.trim()).length ? [right, left] : [left, right];
  return `${toLines(first).join('\n')}\n\n${toLines(second).join('\n')}`;
}

/** Nettoie les blancs en conservant les larges séparations (tabulations entre deux colonnes d'une même ligne). */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\u00a0]/g, ' ')
    .replace(/ {4,}/g, '\u0000')
    .replace(/ {2,}/g, ' ')
    .replace(/\u0000/g, '    ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Fragments de texte d'un PDF avec position, taille et style (gras, italique) lu dans le nom de la police. */
async function pdfItems(data: Uint8Array): Promise<{ pages: Item[][]; totalPages: number }> {
  const { getDocumentProxy } = await import('unpdf');
  // unpdf transfère le tampon : on lui passe une copie pour conserver l'original.
  const pdf = await getDocumentProxy(data.slice(), { fontExtraProperties: true } as never);
  const pages: Item[][] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    await page.getOperatorList().catch(() => undefined);
    const tc = await page.getTextContent();
    const styles = new Map<string, { bold: boolean; italic: boolean }>();
    const styleOf = (fontName: string) => {
      let s = styles.get(fontName);
      if (!s) {
        let name = '';
        try {
          name = String((page.commonObjs.get(fontName) as { name?: string } | undefined)?.name ?? '');
        } catch {
          /* police non chargée : style inconnu */
        }
        s = { bold: /bold|black|heavy|semibold|demi/i.test(name), italic: /italic|oblique/i.test(name) };
        styles.set(fontName, s);
      }
      return s;
    };
    const items: Item[] = [];
    for (const raw of tc.items as { str?: string; transform: number[]; width: number; fontName: string }[]) {
      if (typeof raw.str !== 'string' || raw.str === '') continue;
      const st = styleOf(raw.fontName);
      items.push({ str: raw.str, x: raw.transform[4]!, y: raw.transform[5]!, width: raw.width, fontSize: Math.hypot(raw.transform[2]!, raw.transform[3]!) || 10, bold: st.bold, italic: st.italic });
    }
    pages.push(items);
  }
  return { pages, totalPages: pdf.numPages };
}

/** HTML simple (issu d'un document Word) → texte avec mise en valeur balisée. */
function htmlToMarked(html: string): string {
  return html
    .replace(/<(strong|b)>\s*<(em|i)>([\s\S]*?)<\/(em|i)>\s*<\/(strong|b)>/g, '***$3***')
    .replace(/<(strong|b)>([\s\S]*?)<\/(strong|b)>/g, '**$2**')
    .replace(/<(em|i)>([\s\S]*?)<\/(em|i)>/g, '*$2*')
    .replace(/<li[^>]*>/g, '\n• ')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/(p|h[1-6]|li|tr|div)>/g, '\n')
    .replace(/<\/t[dh]>/g, '    ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\*{2,3}(\s*)\*{2,3}/g, '$1');
}

export async function extractDocumentText(input: { filename: string; mime: string; data: Uint8Array }): Promise<ExtractedDocument> {
  // Un Buffer Node (pilote PostgreSQL) est converti : la lecture PDF n'accepte qu'un Uint8Array ordinaire.
  const file = Buffer.isBuffer(input.data) ? { ...input, data: new Uint8Array(input.data) } : input;
  const kind = sniffKind(file.filename, file.mime, file.data);
  if (!kind) throw badRequest('Format non pris en charge. Importez un fichier PDF, DOCX ou texte.');
  const warnings: string[] = [];

  if (kind === 'pdf') {
    const res = await pdfItems(file.data);
    const text = tidy(res.pages.map((page) => pageToText(page)).join('\n\n'));
    // Un passage mis en valeur qui se poursuit à la ligne suivante garde une seule paire de balises.
    const marked = tidy(res.pages.map((page) => pageToText(page, { markup: true })).join('\n\n')).replace(/(\*{1,3})\n\1(?=\S)/g, '\n');
    if (text.length < 200) warnings.push("Très peu de texte lisible dans ce PDF : il s'agit probablement d'un document scanné. Importez une version texte (export Word/PDF natif) ou collez le contenu.");
    if (res.totalPages > 3) warnings.push(`Le document compte ${res.totalPages} pages : vérifiez qu'il s'agit bien d'un CV.`);
    return { kind, text, marked, pages: res.totalPages, warnings };
  }
  if (kind === 'docx') {
    const mammoth = (await import('mammoth')).default;
    const res = await mammoth.extractRawText({ buffer: Buffer.from(file.data) });
    const html = await mammoth.convertToHtml({ buffer: Buffer.from(file.data) });
    return { kind, text: compactWhitespace(res.value), marked: compactWhitespace(htmlToMarked(html.value)), pages: 1, warnings };
  }
  const plain = compactWhitespace(Buffer.from(file.data).toString('utf8'));
  return { kind, text: plain, marked: plain, pages: 1, warnings };
}
