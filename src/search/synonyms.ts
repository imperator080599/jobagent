// Bibliothèque de synonymes d'intitulés : un même métier porte des noms différents
// selon l'entreprise, le pays et la langue. Elle sert à élargir les requêtes
// envoyées aux sources et à reconnaître une offre pertinente sous un autre intitulé.
// Les groupes fournis couvrent la finance d'entreprise, l'audit et le conseil ;
// l'utilisateur peut en ajouter depuis les paramètres de recherche.
import { normalize, tokens } from '../core/text.js';

export const BUILTIN_SYNONYMS: string[][] = [
  // Français, anglais, espagnol, allemand : un même métier, plusieurs intitulés.
  ['transaction services', 'financial due diligence', 'due diligence financière', 'deal advisory', 'transaction advisory services', 'transaction advisory', 'FDD', 'M&A transaction services', 'conseil en transactions', 'servicios de transacciones', 'due diligence financiera', 'asesoramiento en transacciones', 'Transaktionsberatung', 'Financial Due Diligence Berater'],
  ['M&A', 'fusions-acquisitions', 'fusions acquisitions', 'mergers and acquisitions', 'corporate finance', 'M&A advisory', 'corporate development', 'corp dev', 'fusiones y adquisiciones', 'finanzas corporativas', 'M&A-Beratung', 'Unternehmensfinanzierung'],
  ['financial advisory', 'conseil financier', 'advisory financier', 'asesoramiento financiero', 'Finanzberatung', 'financial advisory services'],
  ['audit financier', 'auditeur financier', 'financial audit', 'external audit', 'statutory audit', 'commissariat aux comptes', 'audit légal', 'assurance'],
  ['contrôle de gestion', 'contrôleur de gestion', 'FP&A', 'financial planning and analysis', 'business controller', 'financial controller', 'controlling', 'business analyst finance'],
  ['analyste financier', 'financial analyst', 'analyste finance', 'finance analyst'],
  ['évaluation', 'valuation', 'valuation and modelling', 'business valuation', 'évaluation financière', 'modélisation financière', 'financial modelling', 'valoración', 'valoración de empresas', 'Unternehmensbewertung'],
  ['private equity', 'capital-investissement', 'capital investissement', 'investment analyst', "chargé d'investissement", 'investment associate', 'capital privado', 'capital riesgo', 'Beteiligungsmanager'],
  ['restructuring', 'restructuration', 'turnaround', 'prévention des difficultés'],
  ['audit interne', 'internal audit', 'contrôle interne', 'internal control'],
  ['consolidation', 'consolidation et reporting', 'group reporting', 'consolideur'],
  ['trésorerie', 'treasury', 'trésorier', 'cash management'],
  ['comptabilité', 'accounting', 'comptable', 'accountant', 'general ledger'],
  ['risk management', 'gestion des risques', 'risk analyst', 'analyste risques'],
  ['strategy consulting', 'conseil en stratégie', 'consultant en stratégie', 'strategy consultant'],
  ['investment banking', "banque d'affaires", "banque d'investissement", 'IBD', 'banca de inversión', 'Investmentbanking'],
];

const key = (s: string) => normalize(s).replace(/[^a-z0-9& ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Variantes d'un intitulé : les membres de chaque groupe dont un terme figure dans l'intitulé. */
export function synonymsOf(title: string, groups: string[][] = BUILTIN_SYNONYMS): string[] {
  const t = ` ${key(title)} `;
  const out = new Set<string>();
  for (const group of groups) {
    const hit = group.find((term) => t.includes(` ${key(term)} `));
    if (!hit) continue;
    for (const term of group) {
      if (key(term) === key(hit)) continue;
      // L'intitulé est repris avec le terme équivalent (« Analyste due diligence financière » → « Analyste transaction services »).
      const swapped = t.replace(` ${key(hit)} `, ` ${term} `).trim();
      out.add(swapped.length > term.length + 2 ? swapped : term);
      out.add(term);
    }
  }
  out.delete(title);
  return [...out];
}

/** Intitulés visés et leurs variantes, sans doublon, les intitulés d'origine en tête. */
export function expandTitles(titles: string[], extraGroups: string[][] = [], limit = 40): string[] {
  const groups = [...extraGroups, ...BUILTIN_SYNONYMS];
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (s: string) => {
    const k = key(s);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(s);
  };
  titles.forEach(add);
  for (const t of titles) synonymsOf(t, groups).forEach(add);
  return out.slice(0, limit);
}

/** Termes de recherche courts à envoyer à un moteur (le cœur du métier, sans le niveau ni le genre). */
export function searchTerms(titles: string[], extraGroups: string[][] = [], limit = 10): string[] {
  const groups = [...extraGroups, ...BUILTIN_SYNONYMS];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const title of titles) {
    const t = ` ${key(title)} `;
    const group = groups.find((g) => g.some((term) => t.includes(` ${key(term)} `)));
    const core = group?.find((term) => t.includes(` ${key(term)} `));
    for (const term of core ? [title, core] : [title]) {
      const k = key(term);
      if (k && !seen.has(k)) {
        seen.add(k);
        out.push(term);
      }
    }
  }
  return out.slice(0, limit);
}

/**
 * Mots significatifs d'un intitulé, pour la comparaison : les sigles à esperluette
 * sont conservés (« M&A », « FP&A », « P&L ») et les terminaisons qui ne changent pas
 * le sens sont neutralisées (« analyste » = « analyst », « services » = « service »).
 */
export function titleTokens(title: string): string[] {
  const kept = title.replace(/(^|[^\p{L}])(\p{L}{1,2})\s*&\s*(\p{L}{1,2})(?=[^\p{L}]|$)/gu, '$1$2and$3');
  return tokens(kept).map((t) => (t.length > 4 ? t.replace(/(es|e|s)$/, '') : t));
}

/** Proximité d'un intitulé d'offre avec un ensemble d'intitulés visés (0..1), synonymes compris. */
export function titleAffinity(jobTitle: string, targets: string[]): number {
  const jt = new Set(titleTokens(jobTitle));
  if (!jt.size) return 0;
  let best = 0;
  for (const target of targets) {
    const tt = titleTokens(target);
    if (!tt.length) continue;
    const hit = tt.filter((x) => jt.has(x)).length;
    // Tous les mots de l'intitulé visé sont dans l'offre → correspondance forte, quel que soit le reste de l'intitulé.
    best = Math.max(best, hit / tt.length);
  }
  return Math.round(best * 100) / 100;
}
