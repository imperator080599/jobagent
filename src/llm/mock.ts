// Fournisseur simulé : sorties déterministes, sans réseau ni coût. Sert aux tests
// automatisés et au mode démonstration. Chaque agent enregistre ici sa propre
// simulation, à côté de son prompt.
import type { LlmJsonRequest, LlmProvider, LlmRequest } from './types.js';
import { sha256 } from '../core/crypto.js';

export type MockHandler = (req: LlmRequest) => unknown | Promise<unknown>;

const handlers = new Map<string, MockHandler>();
const calls: LlmRequest[] = [];

export function registerMock(purpose: string, handler: MockHandler) {
  handlers.set(purpose, handler);
}

/** Tests : remplace temporairement une simulation ; renvoie une fonction de restauration. */
export function overrideMock(purpose: string, handler: MockHandler): () => void {
  const previous = handlers.get(purpose);
  handlers.set(purpose, handler);
  return () => {
    if (previous) handlers.set(purpose, previous);
    else handlers.delete(purpose);
  };
}

export function mockCalls(): LlmRequest[] {
  return calls;
}

export function resetMockCalls() {
  calls.length = 0;
}

const approxTokens = (s: string) => Math.ceil(s.length / 4);

async function run(req: LlmRequest): Promise<unknown> {
  calls.push(req);
  const handler = handlers.get(req.purpose);
  if (!handler) throw new Error(`Aucune simulation enregistrée pour « ${req.purpose} »`);
  return handler(req);
}

export function createMockProvider(): LlmProvider {
  return {
    name: 'mock',
    async text(req) {
      const out = await run(req);
      // Une simulation peut rendre { text, stopReason } pour reproduire une sortie interrompue.
      const shaped = out && typeof out === 'object' && typeof (out as { text?: unknown }).text === 'string' && typeof (out as { stopReason?: unknown }).stopReason === 'string' ? (out as { text: string; stopReason: string }) : null;
      const text = shaped ? shaped.text : typeof out === 'string' ? out : JSON.stringify(out);
      return {
        text,
        model: 'mock',
        provider: 'mock',
        usage: { inputTokens: approxTokens((req.system ?? '') + (req.prefix ?? '') + req.prompt), outputTokens: approxTokens(text), cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: shaped ? shaped.stopReason : 'end_turn',
        refused: false,
        sent: { sha256: sha256(`${req.prefix ? `${req.prefix}\n\n` : ''}${req.prompt}`), chars: (req.prefix ? req.prefix.length + 2 : 0) + req.prompt.length, source: 'mock', systemSha256: sha256(req.system ?? ''), documents: (req.documents ?? []).map((d) => ({ mediaType: d.mediaType, sha256: sha256(d.data), bytes: d.data.byteLength })) },
      };
    },
    async json<T>(req: LlmJsonRequest<T>) {
      const out = await run(req);
      // Même exigence qu'avec le vrai modèle : la sortie doit respecter le schéma.
      const data = req.schema.parse(out);
      return {
        data,
        model: 'mock',
        provider: 'mock',
        usage: { inputTokens: approxTokens((req.system ?? '') + (req.prefix ?? '') + req.prompt), outputTokens: approxTokens(JSON.stringify(out)), cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: 'end_turn',
        refused: false,
      };
    },
  };
}
