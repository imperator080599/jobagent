// Identifiants uniques, triables dans le temps (type ULID), préfixés par type d'objet.
import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

function encodeTime(ms: number): string {
  let out = '';
  let n = Math.max(0, Math.floor(ms));
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
}

function encodeRandom(len: number): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i]! % 32];
  return out;
}

export type IdPrefix =
  | 'usr' | 'ses' | 'tok' | 'act' | 'fil' | 'cv' | 'fact' | 'qa' | 'atp' | 'fb' | 'lis' | 'pdf'
  | 'sp' | 'co' | 'src' | 'run' | 'job' | 'sgt' | 'stg' | 'llm' | 'ats' | 'let' | 'app' | 'att'
  | 'todo' | 'task' | 'eml' | 'dft' | 'itv' | 'ct' | 'ntf' | 'evl' | 'tpl';

export function newId(prefix: IdPrefix, now: number = Date.now()): string {
  return `${prefix}_${encodeTime(now)}${encodeRandom(14)}`;
}
