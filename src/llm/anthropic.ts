// Fournisseur Anthropic (SDK officiel). Choix techniques :
//  - flux (stream) pour les sorties longues : pas de délai d'attente HTTP ;
//  - sorties structurées natives (output_config.format) pour les extractions JSON ;
//  - mise en cache du préfixe stable (prompt ATS + CV) : les offres suivantes
//    ne repaient pas ces tokens au plein tarif ;
//  - repli côté serveur en cas de refus du modèle (fallbacks: "default").
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { ConfigError } from '../core/errors.js';
import type { Usage } from './pricing.js';
import type { LlmJsonRequest, LlmProvider, LlmRequest } from './types.js';

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Les modèles Haiku n'ont pas de repli côté serveur : le paramètre est omis pour eux. */
function supportsFallback(model: string): boolean {
  return !model.includes('haiku');
}

function usageOf(u: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | undefined): Usage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
  };
}

function buildParams(req: LlmRequest, model: string, maxTokens: number) {
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const doc of req.documents ?? []) {
    content.push({ type: 'document', source: { type: 'base64', media_type: doc.mediaType, data: Buffer.from(doc.data).toString('base64') } });
  }
  if (req.prefix) content.push({ type: 'text', text: req.prefix, cache_control: { type: 'ephemeral' } });
  content.push({ type: 'text', text: req.prompt });
  return {
    model,
    max_tokens: maxTokens,
    ...(req.system ? { system: req.system } : {}),
    messages: [{ role: 'user' as const, content }],
    output_config: { effort: req.effort ?? 'medium' },
    ...(supportsFallback(model) ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
  };
}

function mapError(err: unknown): never {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    throw new ConfigError("La clé d'API Anthropic est refusée. Vérifiez-la dans Paramètres → IA et budget.", 'llm_key_invalid');
  }
  throw err;
}

export function createAnthropicProvider(apiKey: string): LlmProvider {
  const client = new Anthropic({ apiKey, maxRetries: 2 });
  return {
    name: 'anthropic',
    async text(req, model) {
      try {
        const stream = client.beta.messages.stream(buildParams(req, model, req.maxTokens ?? 32_000));
        const message = await stream.finalMessage();
        const text = message.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('');
        return { text, model: message.model, provider: 'anthropic', usage: usageOf(message.usage), stopReason: message.stop_reason ?? '', refused: message.stop_reason === 'refusal' };
      } catch (err) {
        mapError(err);
      }
    },
    async json<T>(req: LlmJsonRequest<T>, model: string) {
      try {
        const base = buildParams(req, model, req.maxTokens ?? 16_000);
        const message = await client.beta.messages.parse({
          ...base,
          output_config: { ...base.output_config, format: zodOutputFormat(req.schema) },
        });
        const refused = message.stop_reason === 'refusal';
        if (!refused && message.parsed_output == null) {
          throw new Error(`Sortie structurée illisible (${req.purpose}, arrêt : ${message.stop_reason})`);
        }
        return { data: message.parsed_output as T, model: message.model, provider: 'anthropic', usage: usageOf(message.usage), stopReason: message.stop_reason ?? '', refused };
      } catch (err) {
        mapError(err);
      }
    },
  };
}
