// Fournisseur Anthropic (SDK officiel). Choix techniques :
//  - flux (stream) pour les sorties longues : pas de délai d'attente HTTP ;
//  - sorties structurées natives (output_config.format) pour les extractions JSON ;
//  - mise en cache du préfixe stable (prompt ATS + CV) : les offres suivantes
//    ne repaient pas ces tokens au plein tarif ;
//  - repli côté serveur en cas de refus du modèle (fallbacks: "default").
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { ConfigError } from '../core/errors.js';
import { sha256 } from '../core/crypto.js';
import type { Usage } from './pricing.js';
import type { LlmJsonRequest, LlmProvider, LlmRequest, SentReceipt } from './types.js';

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

function bodyText(body: unknown): string | null {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
  return null;
}

/**
 * Empreintes calculées sur le corps HTTP réellement envoyé à l'API (et non sur les paramètres préparés) :
 * texte du message, consigne système et octets des documents joints.
 */
export function receiptFromBody(body: string): SentReceipt | null {
  try {
    const json = JSON.parse(body) as { system?: unknown; messages?: { content?: unknown }[] };
    const content = json.messages?.[0]?.content;
    const blocks = (Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : []) as { type: string; text?: string; source?: { data?: string; media_type?: string } }[];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    const system = typeof json.system === 'string' ? json.system : Array.isArray(json.system) ? (json.system as { text?: string }[]).map((b) => b.text ?? '').join('') : '';
    const documents = blocks
      .filter((b) => b.type === 'document')
      .map((b) => {
        const bytes = Buffer.from(b.source?.data ?? '', 'base64');
        return { mediaType: b.source?.media_type ?? '', sha256: sha256(new Uint8Array(bytes)), bytes: bytes.byteLength };
      });
    return { sha256: sha256(text), chars: text.length, source: 'http_body', systemSha256: sha256(system), documents };
  } catch {
    return null;
  }
}

export function createAnthropicProvider(apiKey: string, opts: { fetch?: typeof fetch } = {}): LlmProvider {
  const baseFetch = opts.fetch ?? globalThis.fetch;
  const client = new Anthropic({ apiKey, maxRetries: 2, fetch: baseFetch as never });
  return {
    name: 'anthropic',
    async text(req, model) {
      try {
        const params = buildParams(req, model, req.maxTokens ?? 32_000);
        // Client propre à l'appel : le corps HTTP réellement envoyé est relevé au passage, pour en prendre l'empreinte.
        let captured: string | null = null;
        const spy = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
          if (url.includes('/v1/messages')) captured = bodyText(init?.body) ?? captured;
          return baseFetch(input, init);
        }) as typeof fetch;
        const callClient = new Anthropic({ apiKey, maxRetries: 2, fetch: spy as never });
        const stream = callClient.beta.messages.stream(params);
        const message = await stream.finalMessage();
        const text = message.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('');
        const sent = captured ? receiptFromBody(captured) : null;
        return { text, model: message.model, provider: 'anthropic', usage: usageOf(message.usage), stopReason: message.stop_reason ?? '', refused: message.stop_reason === 'refusal', ...(sent ? { sent } : {}) };
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
