// Contrat commun des connecteurs de sources d'offres.
// Un connecteur ne fait que lire une source et restituer ce qu'elle publie. Il doit
// dire honnêtement s'il a pu la parcourir jusqu'au bout : la couverture affichée à
// l'utilisateur en dépend, et la détection des offres retirées aussi.
import type { z } from 'zod';
import type { UserContext } from '../../core/context.js';
import type { SecretKey } from '../../core/secrets.js';
import type { SearchCriteria } from '../../shared/search.js';
import type { RawJob } from '../ingest.js';

export interface ConnectorField {
  key: string;
  label: string;
  hint?: string;
  placeholder?: string;
  required?: boolean;
}

export interface RunInput {
  config: Record<string, unknown>;
  /** Recherches actives de l'utilisateur (une source « moteur » lance une requête par intitulé visé). */
  criteria: SearchCriteria[];
  /** Termes de recherche dérivés des intitulés visés et de leurs synonymes. */
  terms: string[];
  secrets: Partial<Record<SecretKey, string>>;
  /** Appelé pour chaque offre lue. Renvoie false pour demander l'arrêt (budget de temps épuisé). */
  emit: (job: RawJob) => Promise<boolean>;
  /** Plafond de sécurité sur le nombre de requêtes d'une exécution. */
  maxRequests: number;
}

export interface RunOutput {
  /** La source a été lue en entier : toute offre absente de cette lecture n'y est plus publiée. */
  complete: boolean;
  /** Pourquoi la lecture est partielle (plafond, quota, erreur sur une page…). */
  incompleteReason?: string;
  requests: number;
  pages: number;
  queries: unknown[];
  /** Nombre total d'offres annoncé par la source, quand elle le donne. */
  reportedTotal?: number;
}

export interface Connector {
  type: string;
  label: string;
  /** board = toutes les offres d'une entreprise ; search = moteur interrogé par mots-clés ; feed = flux. */
  mode: 'board' | 'search' | 'feed';
  description: string;
  /** Voie d'accès : API publique documentée par la plateforme, ou flux publié par le site. */
  access: string;
  fields: ConnectorField[];
  configSchema: z.ZodType<Record<string, unknown>>;
  secrets?: { key: SecretKey; label: string; hint?: string }[];
  /** L'offre lue ne contient qu'un extrait : le texte complet devra être récupéré avant l'analyse ATS. */
  partialDescriptions?: boolean;
  /** Reconnaît l'adresse d'un site carrières de cette plateforme et en déduit la configuration. */
  detect?(url: URL): { config: Record<string, unknown>; name: string } | null;
  /** Charge le texte complet d'une offre (plateformes dont la liste ne le contient pas). */
  detail?(ctx: UserContext, config: Record<string, unknown>, job: RawJob): Promise<RawJob>;
  run(ctx: UserContext, input: RunInput): Promise<RunOutput>;
}

/** Compteur de requêtes partagé par un connecteur, avec plafond. */
export class RequestBudget {
  used = 0;
  constructor(private max: number) {}
  get exhausted() {
    return this.used >= this.max;
  }
  take(): boolean {
    if (this.used >= this.max) return false;
    this.used++;
    return true;
  }
}
