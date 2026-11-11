// Hachage des mots de passe : scrypt (node:crypto), sel aléatoire par utilisateur,
// paramètres stockés avec l'empreinte pour pouvoir les durcir sans migration.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const PARAMS = process.env.VITEST || process.env.NODE_ENV === 'test' ? { N: 1 << 12, r: 8, p: 1 } : { N: 1 << 17, r: 8, p: 1 };
const KEYLEN = 64;

function derive(password: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r, p, maxmem: 256 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, PARAMS.N, PARAMS.r, PARAMS.p);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, saltB64, keyB64] = stored.split('$');
  if (algo !== 'scrypt' || !n || !r || !p || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64url');
  const key = await derive(password, Buffer.from(saltB64, 'base64url'), Number(n), Number(r), Number(p));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export function passwordProblems(password: string): string | null {
  if (password.length < 12) return 'Le mot de passe doit contenir au moins 12 caractères.';
  if (password.length > 200) return 'Le mot de passe est trop long.';
  if (/^(.)\1+$/.test(password)) return 'Le mot de passe est trop simple.';
  return null;
}
