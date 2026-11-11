// Contrôle qualité d'un document rendu. Un document n'est jamais considéré comme
// terminé parce que le fichier existe : le PDF final est rouvert et mesuré
// (pagination, marges, texte complet, caractères, polices, lisibilité), puis
// comparé au rendu du template lui-même.
import { normalize } from '../core/text.js';
import { pdfFonts } from './convert.js';

export interface DocCheck {
  id: string;
  ok: boolean;
  severity: 'error' | 'warning';
  message: string;
}

export interface DocQaResult {
  /** Aucun contrôle bloquant en échec. */
  ok: boolean;
  checks: DocCheck[];
  pages: number;
  fonts: string[];
  metrics: PageMetrics;
}

export interface PageMetrics {
  pages: number;
  pageWidth: number;
  pageHeight: number;
  /** Bords extrêmes du texte, en points depuis le bord de la page. */
  left: number;
  right: number;
  top: number;
  bottom: number;
  bodyFontSize: number;
  minFontSize: number;
  /** Nombre de lignes de texte sur la dernière page. */
  lastPageLines: number;
  text: string;
}

interface Item {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
}

/** Mesure le rendu réel d'un PDF à partir de son texte positionné. */
export async function measurePdf(pdf: Uint8Array): Promise<PageMetrics> {
  const { extractTextItems, getDocumentProxy } = await import('unpdf');
  const doc = await getDocumentProxy(pdf.slice());
  const first = await doc.getPage(1);
  const vp = first.getViewport({ scale: 1 });
  const res = await extractTextItems(pdf.slice());
  let left = Infinity;
  let right = 0;
  let top = Infinity;
  let bottom = Infinity;
  let minFont = Infinity;
  const sizes = new Map<number, number>();
  const texts: string[] = [];
  let lastPageLines = 0;
  res.items.forEach((page, pageIndex) => {
    const items = (page as Item[]).filter((i) => i.str.trim());
    const lines = new Set<number>();
    for (const it of items) {
      left = Math.min(left, it.x);
      right = Math.max(right, it.x + it.width);
      top = Math.min(top, vp.height - (it.y + it.fontSize * 0.8));
      bottom = Math.min(bottom, it.y - it.fontSize * 0.22);
      minFont = Math.min(minFont, it.fontSize);
      const size = Math.round(it.fontSize * 2) / 2;
      sizes.set(size, (sizes.get(size) ?? 0) + it.str.length);
      lines.add(Math.round(it.y));
    }
    if (pageIndex === res.items.length - 1) lastPageLines = lines.size;
    texts.push((page as Item[]).map((i) => i.str).join(' '));
  });
  const body = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  return {
    pages: res.totalPages,
    pageWidth: vp.width,
    pageHeight: vp.height,
    left: Number.isFinite(left) ? left : 0,
    right: vp.width - right,
    top: Number.isFinite(top) ? top : 0,
    bottom: Number.isFinite(bottom) ? bottom : 0,
    bodyFontSize: body,
    minFontSize: Number.isFinite(minFont) ? minFont : 0,
    lastPageLines,
    text: texts.join('\n'),
  };
}

/** Polices de substitution à métriques identiques, admises quand la police d'origine n'est pas installée. */
const FONT_FAMILIES: Record<string, string[]> = {
  calibri: ['calibri', 'carlito'],
  arial: ['arial', 'liberationsans', 'arimo', 'helvetica'],
  timesnewroman: ['timesnewroman', 'liberationserif', 'tinos', 'times'],
  cambria: ['cambria', 'caladea'],
  couriernew: ['couriernew', 'liberationmono', 'cousine'],
  symbol: ['symbol', 'opensymbol', 'wingdings', 'symbolmt'],
};
const fontKey = (name: string) =>
  name
    .toLowerCase()
    .replace(/^[a-z]{6}\+/, '')
    .replace(/[-,_ ]?(bold|italic|oblique|regular|mt|ps|light|semibold|medium|bolditalic|it|bd)+$/g, '')
    .replace(/[^a-z]/g, '');

export function unexpectedFonts(used: string[], declared: string[]): string[] {
  const allowed = new Set<string>(['opensymbol', 'symbol']);
  for (const d of declared) {
    const k = fontKey(d);
    allowed.add(k);
    for (const alt of FONT_FAMILIES[k] ?? []) allowed.add(alt);
  }
  return [...new Set(used.filter((u) => !allowed.has(fontKey(u))))];
}

const squash = (s: string) => normalize(s).replace(/[^a-z0-9]/g, '');

export interface QaInput {
  pdf: Uint8Array;
  /** Textes qui doivent tous figurer dans le rendu (contenu attendu). */
  expectedTexts: string[];
  /** Pagination du template : la dépasser est une anomalie. */
  maxPages: number;
  /** Polices déclarées par le template. */
  templateFonts?: string[];
  /** Rendu du template lui-même, pour vérifier que la présentation n'a pas dérivé. */
  baseline?: PageMetrics;
  /** Marges de page du document Word, en points. */
  page?: { left: number; right: number; top: number; bottom: number } | null;
}

export async function checkRenderedDocument(input: QaInput): Promise<DocQaResult> {
  const m = await measurePdf(input.pdf);
  const fonts = await pdfFonts(input.pdf);
  const checks: DocCheck[] = [];
  const add = (id: string, ok: boolean, severity: DocCheck['severity'], message: string) => checks.push({ id, ok, severity, message });

  add('pages', m.pages <= input.maxPages, 'error', m.pages <= input.maxPages ? `Pagination respectée (${m.pages} page${m.pages > 1 ? 's' : ''}).` : `Le document occupe ${m.pages} pages au lieu de ${input.maxPages}.`);
  if (m.pages > 1) add('last_page', m.lastPageLines >= 6, 'warning', m.lastPageLines >= 6 ? 'Dernière page suffisamment remplie.' : `La dernière page ne contient que ${m.lastPageLines} ligne(s).`);

  // Texte complet : chaque contenu attendu doit se retrouver dans le PDF (comparaison insensible aux coupures de ligne).
  const haystack = squash(m.text);
  const missing = input.expectedTexts.filter((t) => squash(t).length > 3 && !haystack.includes(squash(t)));
  add('content', missing.length === 0, 'error', missing.length === 0 ? 'Tout le contenu attendu figure dans le document.' : `Contenu absent ou coupé : « ${missing[0]!.slice(0, 80)} »${missing.length > 1 ? ` (+${missing.length - 1})` : ''}.`);

  const badGlyphs = /[�□-]/.test(m.text.replace(/[]/g, ''));
  add('characters', !badGlyphs, 'error', badGlyphs ? 'Des caractères ne s\'affichent pas correctement (glyphes manquants).' : 'Caractères spéciaux correctement rendus.');

  const leftover = /\[[^[\]]{2,60}\]|\{\{[^}]+\}\}|\bundefined\b|\bNaN\b|\[object Object\]/.exec(m.text);
  add('placeholders', !leftover, 'error', leftover ? `Zone de modèle non remplie : « ${leftover[0]} ».` : 'Aucune zone de modèle laissée vide.');

  if (input.page) {
    const tol = 3;
    const out: string[] = [];
    if (m.left < input.page.left - tol) out.push('gauche');
    if (m.right < input.page.right - tol) out.push('droite');
    if (m.top < input.page.top - tol - 2) out.push('haut');
    if (m.bottom < input.page.bottom - tol - 2) out.push('bas');
    add('margins', out.length === 0, 'error', out.length ? `Du texte déborde dans la marge (${out.join(', ')}).` : 'Marges respectées.');
  }

  add('legibility', m.minFontSize >= 7.5, 'warning', m.minFontSize >= 7.5 ? `Taille de caractères lisible (corps ${m.bodyFontSize} pt).` : `Texte très petit détecté (${m.minFontSize.toFixed(1)} pt).`);

  if (input.templateFonts?.length && fonts.length) {
    const odd = unexpectedFonts(fonts, input.templateFonts);
    add('fonts', odd.length === 0, 'warning', odd.length ? `Police inattendue dans le rendu : ${odd.join(', ')}.` : 'Polices conformes au template.');
  }

  if (input.baseline) {
    const b = input.baseline;
    const drift: string[] = [];
    if (Math.abs(m.bodyFontSize - b.bodyFontSize) > 0.01) drift.push(`taille du texte ${m.bodyFontSize} pt au lieu de ${b.bodyFontSize} pt`);
    if (Math.abs(m.left - b.left) > 2) drift.push('marge gauche');
    if (Math.abs(m.top - b.top) > 3) drift.push('marge haute');
    if (Math.abs(m.pageWidth - b.pageWidth) > 1 || Math.abs(m.pageHeight - b.pageHeight) > 1) drift.push('format de page');
    add('template', drift.length === 0, 'warning', drift.length ? `Écart avec le template : ${drift.join(', ')}.` : 'Présentation identique à celle du template.');
  }

  return { ok: checks.every((c) => c.ok || c.severity !== 'error'), checks, pages: m.pages, fonts, metrics: m };
}
