// Critères d'une recherche d'emploi. Partagés entre l'interface (formulaire), les
// connecteurs (requêtes) et la qualification (filtres déterministes).
import { z } from 'zod';

export const CONTRACTS = ['cdi', 'cdd', 'vie', 'internship', 'apprenticeship', 'freelance', 'temp', 'graduate'] as const;
export const CONTRACT_LABELS: Record<(typeof CONTRACTS)[number], string> = {
  cdi: 'CDI',
  cdd: 'CDD',
  vie: 'V.I.E',
  internship: 'Stage',
  apprenticeship: 'Alternance',
  freelance: 'Freelance',
  temp: 'Intérim',
  graduate: 'Graduate programme',
};

export const SENIORITIES = ['intern', 'junior', 'mid', 'senior', 'manager', 'director'] as const;
export const SENIORITY_LABELS: Record<(typeof SENIORITIES)[number], string> = {
  intern: 'Stagiaire / alternant',
  junior: 'Junior',
  mid: 'Confirmé',
  senior: 'Senior',
  manager: 'Manager',
  director: 'Direction',
};

const list = (max = 80) => z.array(z.string().trim().min(1).max(120)).max(max).default([]);

export const SearchCriteria = z.object({
  /** Intitulés visés (les synonymes connus sont ajoutés automatiquement aux recherches). */
  titles: list(),
  /** Mots-clés souhaités : leur présence renforce la pertinence. */
  keywords: list(),
  /** Mots dont la présence dans l'intitulé écarte l'offre. */
  excludeKeywords: list(),
  /** Pays visés (codes ISO à deux lettres). Vide = tous. */
  countries: z.array(z.string().trim().length(2)).max(60).default([]),
  cities: list(),
  /** Accepter les postes en télétravail complet hors des pays visés. */
  remoteAnywhere: z.boolean().default(false),
  contracts: z.array(z.enum(CONTRACTS)).default([]),
  seniority: z.array(z.enum(SENIORITIES)).default([]),
  /** Écarter les offres qui exigent plus d'années d'expérience que cette valeur. */
  maxYearsRequired: z.number().min(0).max(40).nullable().default(null),
  /** Langues de l'annonce acceptées (fr, en…). Vide = toutes. */
  languages: z.array(z.string().trim().min(2).max(5)).max(10).default([]),
  /** Ancienneté maximale d'une annonce, en jours. */
  maxAgeDays: z.number().int().min(1).max(365).default(60),
});
export type SearchCriteria = z.infer<typeof SearchCriteria>;

export const EMPTY_CRITERIA: SearchCriteria = SearchCriteria.parse({});
