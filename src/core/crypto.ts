// Primitives cryptographiques : chiffrement des secrets au repos (AES-256-GCM),
// empreintes, jetons aléatoires, signatures HMAC. Uniquement node:crypto.
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

function deriveKey(appSecret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(appSecret, 'utf8'), Buffer.from('jobagent.v1'), Buffer.from(purpose), 32));
}

/** Chiffre une valeur ; le résultat (v1.iv.tag.data en base64url) est sûr à stocker en base. */
export function encryptSecret(appSecret: string, plaintext: string): string {
  const key = deriveKey(appSecret, 'secrets');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join('.');
}

export function decryptSecret(appSecret: string, ciphertext: string): string {
  const [v, ivB64, tagB64, dataB64] = ciphertext.split('.');
  if (v !== 'v1' || !ivB64 || !tagB64 || dataB64 === undefined) throw new Error('Format de secret inconnu');
  const key = deriveKey(appSecret, 'secrets');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
}

export function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hmacSign(appSecret: string, purpose: string, message: string): string {
  return createHmac('sha256', deriveKey(appSecret, `hmac:${purpose}`)).update(message).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Masque un secret pour l'affichage : ne révèle que les 4 derniers caractères. */
export function secretHint(value: string): string {
  if (value.length <= 8) return '••••';
  return `••••${value.slice(-4)}`;
}
