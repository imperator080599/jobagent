import type { z } from 'zod';
import type { Usage } from './pricing.js';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface LlmRequest {
  /** Finalité de l'appel (suivi des coûts, journal) : 'ats.analyze', 'cv.tailor'… */
  purpose: string;
  /** main = modèle principal (forte valeur) ; bulk = modèle économique (volume). */
  tier: 'main' | 'bulk';
  system?: string;
  /** Préfixe stable partagé par de nombreuses requêtes : mis en cache côté API. */
  prefix?: string;
  prompt: string;
  /** Documents joints lus nativement par le modèle (PDF d'un CV, par exemple). */
  documents?: { mediaType: 'application/pdf'; data: Uint8Array }[];
  maxTokens?: number;
  effort?: Effort;
  jobId?: string;
}

export interface LlmJsonRequest<T> extends LlmRequest {
  schema: z.ZodType<T>;
}

export interface LlmMeta {
  model: string;
  provider: string;
  usage: Usage;
  costUsd: number;
  stopReason: string;
  /** Le modèle a décliné la requête (filtre de sécurité) : la sortie est inexploitable. */
  refused: boolean;
  durationMs: number;
}

/** Ce que le fournisseur a effectivement transmis pour le message (empreintes calculées sur ce qui part réellement). */
export interface SentReceipt {
  /** Empreinte du texte du message (blocs texte, dans l'ordre). */
  sha256: string;
  chars: number;
  /** Où l'empreinte a été prise : corps HTTP réellement envoyé à l'API, entrée standard de Claude Code, ou simulation. */
  source: 'http_body' | 'stdin' | 'mock';
  /** Empreinte de la consigne système transmise. */
  systemSha256?: string;
  /** Documents joints tels que transmis (octets décodés du corps de la requête). */
  documents?: { mediaType: string; sha256: string; bytes: number }[];
}

export interface LlmTextResult extends LlmMeta {
  text: string;
  sent?: SentReceipt;
}

export interface LlmJsonResult<T> extends LlmMeta {
  data: T;
}

/** Fournisseur bas niveau : un appel = une requête au modèle, sans logique métier. */
export interface LlmProvider {
  name: string;
  text(req: LlmRequest, model: string): Promise<Omit<LlmTextResult, 'costUsd' | 'durationMs'>>;
  json<T>(req: LlmJsonRequest<T>, model: string): Promise<Omit<LlmJsonResult<T>, 'costUsd' | 'durationMs'>>;
}

/** Client utilisé par les agents : budget, coûts et journalisation inclus. */
export interface Llm {
  provider: string;
  text(req: LlmRequest): Promise<LlmTextResult>;
  json<T>(req: LlmJsonRequest<T>): Promise<LlmJsonResult<T>>;
}
