// Extraction du texte d'un document importé (PDF, DOCX, texte). Le fichier
// d'origine est toujours conservé tel quel ; le texte sert à la structuration.
import { compactWhitespace } from '../core/text.js';
import { badRequest } from '../core/errors.js';

export interface ExtractedDocument {
  kind: 'pdf' | 'docx' | 'text';
  text: string;
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
}

/**
 * Reconstruit l'ordre de lecture d'une page : regroupe les fragments en lignes et,
 * si une gouttière verticale sépare deux colonnes, lit chaque colonne séparément
 * (les CV en deux colonnes seraient sinon entremêlés ligne à ligne).
 */
export function pageToText(items: Item[]): string {
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
  const hasColumns = gutter !== null && best >= 3 && clean.filter((i) => i.x > gutter!).length > clean.length * 0.15 && clean.filter((i) => i.x + i.width < gutter!).length > clean.length * 0.15;

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
      let out = '';
      let prevEnd: number | null = null;
      for (const it of line) {
        if (prevEnd !== null) {
          const gap = it.x - prevEnd;
          if (gap > it.fontSize * 2.2) out += '    ';
          else if (gap > it.fontSize * 0.18 && !out.endsWith(' ') && !it.str.startsWith(' ')) out += ' ';
        }
        out += it.str;
        prevEnd = it.x + it.width;
      }
      return out.trimEnd();
    });
  };

  if (!hasColumns) return toLines(clean).join('\n');
  const left = clean.filter((i) => i.x + i.width / 2 < gutter!);
  const right = clean.filter((i) => i.x + i.width / 2 >= gutter!);
  // La colonne la plus large porte généralement le contenu principal : on la lit en premier.
  const [first, second] = right.length >= left.length ? [right, left] : [left, right];
  return `${toLines(first).join('\n')}\n\n${toLines(second).join('\n')}`;
}

export async function extractDocumentText(file: { filename: string; mime: string; data: Uint8Array }): Promise<ExtractedDocument> {
  const kind = sniffKind(file.filename, file.mime, file.data);
  if (!kind) throw badRequest('Format non pris en charge. Importez un fichier PDF, DOCX ou texte.');
  const warnings: string[] = [];

  if (kind === 'pdf') {
    const { extractTextItems } = await import('unpdf');
    // unpdf transfère le tampon : on lui passe une copie pour conserver l'original.
    const res = await extractTextItems(file.data.slice());
    const text = compactWhitespace(res.items.map((page) => pageToText(page as Item[])).join('\n\n'));
    if (text.length < 200) warnings.push("Très peu de texte lisible dans ce PDF : il s'agit probablement d'un document scanné. Importez une version texte (export Word/PDF natif) ou collez le contenu.");
    if (res.totalPages > 3) warnings.push(`Le document compte ${res.totalPages} pages : vérifiez qu'il s'agit bien d'un CV.`);
    return { kind, text, pages: res.totalPages, warnings };
  }
  if (kind === 'docx') {
    const mammoth = (await import('mammoth')).default;
    const res = await mammoth.extractRawText({ buffer: Buffer.from(file.data) });
    return { kind, text: compactWhitespace(res.value), pages: 1, warnings };
  }
  return { kind, text: compactWhitespace(Buffer.from(file.data).toString('utf8')), pages: 1, warnings };
}
