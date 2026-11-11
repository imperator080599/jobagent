// Tarifs indicatifs (USD par million de tokens) servant au suivi des coûts et au
// respect du budget. Source : tarifs publics Anthropic à la date d'écriture ;
// à ajuster ici si la grille évolue. Un modèle inconnu est valorisé au tarif Opus
// (estimation prudente : on préfère surestimer une dépense que la sous-estimer).
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const p = (input: number, output: number, cacheRead?: number): ModelPrice => ({
  input,
  output,
  cacheRead: cacheRead ?? input * 0.1,
  cacheWrite: input * 1.25,
});

export const PRICING: Record<string, ModelPrice> = {
  'claude-fable-5-2': p(8, 40, 0.2),
  'claude-opus-5-5': p(4, 20, 0.2),
  'claude-opus-5': p(5, 25),
  'claude-sonnet-5-5': p(2, 10, 0.1),
  'claude-sonnet-5': p(2, 10),
  'claude-haiku-5-5': p(0.1, 0.5),
  'claude-haiku-4-5': p(1, 5),
  mock: p(0, 0, 0),
};

const FALLBACK = PRICING['claude-opus-5-5']!;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function costUsd(model: string, u: Usage): number {
  const price = PRICING[model] ?? FALLBACK;
  return (u.inputTokens * price.input + u.outputTokens * price.output + u.cacheReadTokens * price.cacheRead + u.cacheWriteTokens * price.cacheWrite) / 1_000_000;
}
