// Outils de texte déterministes : normalisation, similarité, empreintes.
// Utilisés par la déduplication, le rapprochement des questions et les contrôles
// de véracité — là où une règle simple est plus fiable qu'un modèle.

/** Minuscules, sans accents ni ponctuation, espaces compactés. */
export function normalize(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`´]/g, "'")
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9+#.' ]+/g, ' ')
    .replace(/(^|\s)[.']+|[.']+(\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set(
  (
    'a an and are as at be by for from has have in is it of on or that the to with your you we our their this these those will ' +
    'le la les l un une des du de d et ou en au aux pour par sur dans avec sans que qui quoi est sont a ont vous votre vos nous notre nos ce cette ces se sa son ses il elle ils elles ' +
    'el los las una unos unas y o en con por para que es son su sus al del ' +
    'der die das und oder mit von zu im in den dem ein eine fur ist sind'
  ).split(' '),
);

export function tokens(input: string, opts: { keepStopwords?: boolean } = {}): string[] {
  const out = normalize(input).split(' ').filter(Boolean);
  return opts.keepStopwords ? out : out.filter((t) => !STOPWORDS.has(t) && t.length > 1);
}

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Similarité de deux textes courts (intitulés, questions) : Jaccard sur les mots significatifs. */
export function tokenSimilarity(a: string, b: string): number {
  return jaccard(new Set(tokens(a)), new Set(tokens(b)));
}

/** Suites de k mots consécutifs : compare des textes longs en tenant compte de l'ordre. */
export function shingles(input: string, k = 4): Set<string> {
  const t = tokens(input, { keepStopwords: true });
  const out = new Set<string>();
  if (t.length < k) {
    if (t.length) out.add(t.join(' '));
    return out;
  }
  for (let i = 0; i <= t.length - k; i++) out.add(t.slice(i, i + k).join(' '));
  return out;
}

/** Similarité de deux descriptions longues (0 = sans rapport, 1 = identiques). */
export function textSimilarity(a: string, b: string): number {
  return jaccard(shingles(a), shingles(b));
}

/** Part des mots significatifs de `needle` présents dans `haystack` (0..1). */
export function coverage(needle: string, haystackTokens: Set<string>): number {
  const t = tokens(needle);
  if (t.length === 0) return 1;
  let hit = 0;
  for (const x of t) if (haystackTokens.has(x)) hit++;
  return hit / t.length;
}

export function slugify(input: string): string {
  return normalize(input).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function truncate(input: string, max: number): string {
  return input.length <= max ? input : `${input.slice(0, max - 1).trimEnd()}…`;
}

export function compactWhitespace(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Distance d'édition bornée (Levenshtein) pour tolérer les fautes de frappe courtes. */
export function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/** Détection sommaire de la langue d'un texte (fr, en, es, de) par mots-outils. */
export function detectLanguage(text: string): 'fr' | 'en' | 'es' | 'de' | '' {
  const sample = ` ${normalize(text.slice(0, 6000))} `;
  const count = (words: string[]) => words.reduce((n, w) => n + (sample.split(` ${w} `).length - 1), 0);
  const scores: Record<string, number> = {
    fr: count(['le', 'la', 'les', 'des', 'et', 'vous', 'nous', 'pour', 'dans', 'avec', 'une', 'votre', 'est', 'au', 'sur']),
    en: count(['the', 'and', 'of', 'to', 'with', 'you', 'our', 'for', 'in', 'will', 'your', 'we', 'are', 'is', 'as']),
    es: count(['el', 'los', 'las', 'y', 'para', 'con', 'una', 'del', 'que', 'en', 'por', 'su', 'se', 'nuestro', 'es']),
    de: count(['der', 'die', 'das', 'und', 'mit', 'fur', 'wir', 'sie', 'ist', 'von', 'zu', 'im', 'eine', 'den', 'auf']),
  };
  const [best, second] = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (!best || best[1] < 3) return '';
  if (second && best[1] < second[1] * 1.15) return '';
  return best[0] as 'fr' | 'en' | 'es' | 'de';
}
