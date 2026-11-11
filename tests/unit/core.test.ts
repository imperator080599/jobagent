import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, hmacSign, safeEqual, secretHint, sha256 } from '../../src/core/crypto.js';
import { base32Decode, base32Encode, totpCode, verifyTotp } from '../../src/auth/totp.js';
import { hashPassword, passwordProblems, verifyPassword } from '../../src/auth/passwords.js';
import { newId } from '../../src/db/ids.js';
import { STAGES, atsDecision, canTransition, isSubmitted } from '../../src/shared/stages.js';

const SECRET = 'x'.repeat(48);

describe('chiffrement des secrets', () => {
  it('chiffre et déchiffre, avec un texte chiffré différent à chaque fois', () => {
    const a = encryptSecret(SECRET, 'sk-ant-api-key-123');
    const b = encryptSecret(SECRET, 'sk-ant-api-key-123');
    expect(a).not.toEqual(b);
    expect(a).not.toContain('sk-ant');
    expect(decryptSecret(SECRET, a)).toBe('sk-ant-api-key-123');
  });
  it('refuse un texte altéré ou une autre clé maître', () => {
    const c = encryptSecret(SECRET, 'valeur');
    const parts = c.split('.');
    parts[3] = Buffer.from('autre').toString('base64url');
    expect(() => decryptSecret(SECRET, parts.join('.'))).toThrow();
    expect(() => decryptSecret('y'.repeat(48), c)).toThrow();
  });
  it('masque les secrets à l’affichage', () => {
    expect(secretHint('sk-ant-abcdef123456')).toBe('••••3456');
    expect(secretHint('court')).toBe('••••');
  });
  it('signe et compare en temps constant', () => {
    expect(hmacSign(SECRET, 'a', 'm')).toBe(hmacSign(SECRET, 'a', 'm'));
    expect(hmacSign(SECRET, 'a', 'm')).not.toBe(hmacSign(SECRET, 'b', 'm'));
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('TOTP (RFC 6238)', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it('reproduit les vecteurs de test de la RFC', () => {
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    expect(totpCode(secret, 59_000)).toBe('287082');
    expect(totpCode(secret, 1111111109_000)).toBe('081804');
    expect(totpCode(secret, 1234567890_000)).toBe('005924');
  });
  it('tolère une dérive de ±30 s, pas plus', () => {
    const t = 1234567890_000;
    expect(verifyTotp(secret, '005924', t)).toBe(true);
    expect(verifyTotp(secret, '005924', t + 30_000)).toBe(true);
    expect(verifyTotp(secret, '005924', t + 90_000)).toBe(false);
    expect(verifyTotp(secret, 'abcdef', t)).toBe(false);
  });
});

describe('mots de passe', () => {
  it('hache avec un sel unique et vérifie', async () => {
    const h1 = await hashPassword('un-mot-de-passe-long');
    const h2 = await hashPassword('un-mot-de-passe-long');
    expect(h1).not.toBe(h2);
    expect(await verifyPassword('un-mot-de-passe-long', h1)).toBe(true);
    expect(await verifyPassword('un-autre', h1)).toBe(false);
    expect(await verifyPassword('x', 'format-inconnu')).toBe(false);
  });
  it('impose une longueur minimale', () => {
    expect(passwordProblems('court')).toMatch(/12 caractères/);
    expect(passwordProblems('aaaaaaaaaaaaaaaa')).toMatch(/trop simple/);
    expect(passwordProblems('correct-horse-battery')).toBeNull();
  });
});

describe('identifiants', () => {
  it('sont préfixés, uniques et triables dans le temps', () => {
    const a = newId('job', 1_000);
    const b = newId('job', 2_000);
    expect(a.startsWith('job_')).toBe(true);
    expect(a < b).toBe(true);
    expect(new Set(Array.from({ length: 2000 }, () => newId('job'))).size).toBe(2000);
  });
});

describe('statuts du pipeline', () => {
  it('couvre les 17 statuts demandés', () => {
    for (const s of ['new', 'to_analyze', 'analyzed', 'awaiting_feedback', 'cv_in_progress', 'letter_in_progress', 'ready_to_apply', 'applying', 'sent', 'confirmed', 'interview_hr', 'interview_tech', 'offer', 'rejected', 'no_response', 'follow_up_needed', 'abandoned']) {
      expect(STAGES).toContain(s);
    }
  });
  it('interdit de revenir en préparation une fois la candidature envoyée', () => {
    expect(canTransition('ready_to_apply', 'applying')).toBe(true);
    expect(canTransition('applying', 'sent')).toBe(true);
    for (const from of ['sent', 'confirmed', 'interview_hr', 'offer', 'rejected', 'follow_up_needed', 'no_response'] as const) {
      expect(isSubmitted(from)).toBe(true);
      for (const to of ['new', 'to_analyze', 'cv_in_progress', 'ready_to_apply', 'applying'] as const) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });
  it('applique les seuils de décision ATS', () => {
    expect(atsDecision(15)).toBe('excellent');
    expect(atsDecision(14.99)).toBe('interesting');
    expect(atsDecision(13)).toBe('interesting');
    expect(atsDecision(12.99)).toBe('limited');
    expect(atsDecision(11)).toBe('limited');
    expect(atsDecision(10.99)).toBe('weak');
    expect(atsDecision(14, { excellent: 14, interesting: 12, limited: 10 })).toBe('excellent');
  });
});
