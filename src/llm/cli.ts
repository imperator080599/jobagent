// Fournisseur optionnel « Claude Code en ligne de commande » (LLM_PROVIDER=claude-cli).
// Utilise l'installation locale de Claude Code et son authentification (abonnement
// ou clé) : utile en local ou en conteneur, indisponible en serverless.
// Aucun outil n'est accordé au modèle : il ne peut que répondre.
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { ConfigError } from '../core/errors.js';
import { sha256 } from '../core/crypto.js';
import type { LlmJsonRequest, LlmProvider, LlmRequest } from './types.js';

interface CliResult {
  result?: string;
  structured_output?: unknown;
  is_error?: boolean;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  modelUsage?: Record<string, unknown>;
}

function runCli(args: string[], input: string, timeoutMs: number): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.CLAUDE_CLI_PATH || 'claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Claude CLI : délai dépassé (${Math.round(timeoutMs / 1000)} s)`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new ConfigError('Claude Code (commande `claude`) est introuvable sur cette machine.', 'llm_cli_missing') : e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out) as CliResult;
        if (parsed.is_error) return reject(new Error(`Claude CLI : ${String(parsed.result).slice(0, 500)}`));
        resolve(parsed);
      } catch {
        reject(new Error(`Claude CLI a échoué (code ${code}) : ${(err || out).slice(0, 500)}`));
      }
    });
    child.stdin.end(input);
  });
}

function baseArgs(req: LlmRequest, model: string): string[] {
  return [
    '-p',
    '--output-format', 'json',
    '--model', model,
    '--system-prompt', req.system ?? 'Tu es un assistant précis et rigoureux.',
    '--tools', '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--effort', req.effort ?? 'medium',
  ];
}

const usage = (r: CliResult) => ({
  inputTokens: r.usage?.input_tokens ?? 0,
  outputTokens: r.usage?.output_tokens ?? 0,
  cacheReadTokens: r.usage?.cache_read_input_tokens ?? 0,
  cacheWriteTokens: r.usage?.cache_creation_input_tokens ?? 0,
});

const served = (r: CliResult, asked: string) => Object.keys(r.modelUsage ?? {})[0] ?? asked;

export function createCliProvider(): LlmProvider {
  return {
    name: 'claude-cli',
    async text(req, model) {
      const input = `${req.prefix ? `${req.prefix}\n\n` : ''}${req.prompt}`;
      const r = await runCli(baseArgs(req, model), input, 15 * 60_000);
      // Empreinte du texte écrit sur l'entrée standard de Claude Code (au-delà, la transmission relève de l'outil).
      return { text: r.result ?? '', model: served(r, model), provider: 'claude-cli', usage: usage(r), stopReason: r.stop_reason ?? '', refused: r.stop_reason === 'refusal', sent: { sha256: sha256(input), chars: input.length, source: 'stdin', systemSha256: sha256(baseArgs(req, model)[baseArgs(req, model).indexOf('--system-prompt') + 1]!), documents: [] } };
    },
    async json<T>(req: LlmJsonRequest<T>, model: string) {
      // La CLI n'accepte pas l'en-tête « $schema » : on ne transmet que le schéma lui-même.
      const { $schema: _ignored, ...jsonSchema } = z.toJSONSchema(req.schema) as Record<string, unknown>;
      const schema = JSON.stringify(jsonSchema);
      const r = await runCli([...baseArgs(req, model), '--json-schema', schema], `${req.prefix ? `${req.prefix}\n\n` : ''}${req.prompt}`, 15 * 60_000);
      const refused = r.stop_reason === 'refusal';
      let raw: unknown = r.structured_output;
      if (raw === undefined && r.result) {
        try {
          raw = JSON.parse(r.result.replace(/^```(?:json)?\s*|\s*```$/g, ''));
        } catch {
          /* géré ci-dessous */
        }
      }
      if (refused) return { data: undefined as T, model: served(r, model), provider: 'claude-cli', usage: usage(r), stopReason: r.stop_reason ?? '', refused };
      const data = req.schema.parse(raw);
      return { data, model: served(r, model), provider: 'claude-cli', usage: usage(r), stopReason: r.stop_reason ?? '', refused };
    },
  };
}
