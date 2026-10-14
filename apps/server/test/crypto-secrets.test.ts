import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  encryptSecret,
  decryptSecret,
  validateMasterKey,
  resolveMasterKey,
  SecretCryptoError,
  CIPHER_VERSION,
  KEY_BYTE_LENGTH
} from '../src/oracle/crypto-secrets.js';

describe('crypto-secrets (AES-256-GCM)', () => {
  const sampleKeyHex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const sampleKeyBuffer = Buffer.from(sampleKeyHex, 'hex');

  describe('validateMasterKey', () => {
    it('accepts a valid 64-character hex string', () => {
      const key = validateMasterKey(sampleKeyHex);
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(KEY_BYTE_LENGTH);
      expect(key.toString('hex')).toBe(sampleKeyHex);
    });

    it('accepts a valid 32-byte Buffer', () => {
      const key = validateMasterKey(sampleKeyBuffer);
      expect(key.length).toBe(KEY_BYTE_LENGTH);
      expect(key.equals(sampleKeyBuffer)).toBe(true);
    });

    it('rejects null, undefined, or empty key', () => {
      expect(() => validateMasterKey(null)).toThrow(SecretCryptoError);
      expect(() => validateMasterKey(undefined)).toThrow(SecretCryptoError);
      expect(() => validateMasterKey('')).toThrow(SecretCryptoError);
    });

    it('rejects non-hex characters in key string', () => {
      const nonHexKey = 'g'.repeat(64);
      expect(() => validateMasterKey(nonHexKey)).toThrow(/Invalid master key format/);
    });

    it('rejects keys with invalid lengths', () => {
      expect(() => validateMasterKey(sampleKeyHex.slice(0, 62))).toThrow(/Invalid master key format/);
      expect(() => validateMasterKey(sampleKeyHex + 'ab')).toThrow(/Invalid master key format/);
      expect(() => validateMasterKey(Buffer.alloc(31))).toThrow(/Invalid master key buffer length/);
      expect(() => validateMasterKey(Buffer.alloc(33))).toThrow(/Invalid master key buffer length/);
    });
  });

  describe('resolveMasterKey', () => {
    it('resolves key from direct environment variable OLP_MASTER_KEY', () => {
      const env = { OLP_MASTER_KEY: sampleKeyHex };
      const key = resolveMasterKey(env);
      expect(key.toString('hex')).toBe(sampleKeyHex);
    });

    it('resolves key from file path OLP_MASTER_KEY_FILE', () => {
      const tempPath = join(tmpdir(), `olp-test-key-${Date.now()}.key`);
      writeFileSync(tempPath, `${sampleKeyHex}\n`, 'utf8');
      try {
        const env = { OLP_MASTER_KEY_FILE: tempPath };
        const key = resolveMasterKey(env);
        expect(key.toString('hex')).toBe(sampleKeyHex);
      } finally {
        unlinkSync(tempPath);
      }
    });

    it('throws when key file does not exist', () => {
      const env = { OLP_MASTER_KEY_FILE: '/path/to/nonexistent/master.key' };
      expect(() => resolveMasterKey(env)).toThrow(/Master key file not found/);
    });

    it('throws when neither OLP_MASTER_KEY nor OLP_MASTER_KEY_FILE is set', () => {
      expect(() => resolveMasterKey({})).toThrow(/No master key configured/);
    });
  });

  describe('encryptSecret and decryptSecret round-trip', () => {
    it('encrypts and decrypts standard plaintext', () => {
      const plaintext = 'SuperSecretDbPassword123!#$';
      const payload = encryptSecret(plaintext, sampleKeyHex);

      expect(payload.startsWith(`${CIPHER_VERSION}:`)).toBe(true);
      const decrypted = decryptSecret(payload, sampleKeyHex);
      expect(decrypted).toBe(plaintext);
    });

    it('encrypts and decrypts empty string', () => {
      const plaintext = '';
      const payload = encryptSecret(plaintext, sampleKeyBuffer);
      const decrypted = decryptSecret(payload, sampleKeyBuffer);
      expect(decrypted).toBe('');
    });

    it('handles multi-byte unicode characters cleanly', () => {
      const unicodePlaintext = 'KoneksiDatabase-🔐-日本語-€-©';
      const payload = encryptSecret(unicodePlaintext, sampleKeyHex);
      const decrypted = decryptSecret(payload, sampleKeyHex);
      expect(decrypted).toBe(unicodePlaintext);
    });

    it('ensures distinct IV for every encryption call (nonce freshness)', () => {
      const plaintext = 'identical-secret';
      const payload1 = encryptSecret(plaintext, sampleKeyHex);
      const payload2 = encryptSecret(plaintext, sampleKeyHex);

      expect(payload1).not.toBe(payload2);
      const iv1 = payload1.split(':')[1];
      const iv2 = payload2.split(':')[1];
      expect(iv1).not.toBe(iv2);

      expect(decryptSecret(payload1, sampleKeyHex)).toBe(plaintext);
      expect(decryptSecret(payload2, sampleKeyHex)).toBe(plaintext);
    });
  });

  describe('Tampering and error handling', () => {
    const validPlaintext = 'MyTargetSecret';
    let validPayload: string;

    beforeEach(() => {
      validPayload = encryptSecret(validPlaintext, sampleKeyHex);
    });

    it('fails to decrypt with a different valid 32-byte key', () => {
      const otherKeyHex = randomBytes(32).toString('hex');
      expect(() => decryptSecret(validPayload, otherKeyHex)).toThrow(SecretCryptoError);
      expect(() => decryptSecret(validPayload, otherKeyHex)).toThrow(/Decryption failed/);
    });

    it('fails when ciphertext is modified (tampered data)', () => {
      const parts = validPayload.split(':');
      const cipher = parts[3]!;
      // Flip the last hex character
      const lastChar = cipher.slice(-1);
      const flipped = lastChar === 'a' ? 'b' : 'a';
      const tamperedCipher = cipher.slice(0, -1) + flipped;
      const tamperedPayload = `${parts[0]}:${parts[1]}:${parts[2]}:${tamperedCipher}`;

      expect(() => decryptSecret(tamperedPayload, sampleKeyHex)).toThrow(SecretCryptoError);
      expect(() => decryptSecret(tamperedPayload, sampleKeyHex)).toThrow(/Decryption failed/);
    });

    it('fails when authentication tag is modified', () => {
      const parts = validPayload.split(':');
      const tag = parts[2]!;
      const flipped = tag.slice(-1) === '0' ? '1' : '0';
      const tamperedTag = tag.slice(0, -1) + flipped;
      const tamperedPayload = `${parts[0]}:${parts[1]}:${tamperedTag}:${parts[3]}`;

      expect(() => decryptSecret(tamperedPayload, sampleKeyHex)).toThrow(SecretCryptoError);
      expect(() => decryptSecret(tamperedPayload, sampleKeyHex)).toThrow(/Decryption failed/);
    });

    it('fails when IV is modified', () => {
      const parts = validPayload.split(':');
      const iv = parts[1]!;
      const flipped = iv.slice(-1) === '0' ? '1' : '0';
      const tamperedIv = iv.slice(0, -1) + flipped;
      const tamperedPayload = `${parts[0]}:${tamperedIv}:${parts[2]}:${parts[3]}`;

      expect(() => decryptSecret(tamperedPayload, sampleKeyHex)).toThrow(SecretCryptoError);
      expect(() => decryptSecret(tamperedPayload, sampleKeyHex)).toThrow(/Decryption failed/);
    });

    it('rejects unsupported version or malformed format', () => {
      expect(() => decryptSecret('v2:12:34:56', sampleKeyHex)).toThrow(/Invalid encrypted payload format/);
      expect(() => decryptSecret('not-a-valid-payload', sampleKeyHex)).toThrow(/Invalid encrypted payload format/);
      expect(() => decryptSecret('v1:nonhexiv:0123456789abcdef0123456789abcdef:cdef', sampleKeyHex)).toThrow(/valid hexadecimal/);
      expect(() => decryptSecret('v1:1234:0123456789abcdef0123456789abcdef:cdef', sampleKeyHex)).toThrow(/Invalid IV length/);
    });

    it('does not leak plaintext in error messages', () => {
      try {
        const wrongKey = randomBytes(32).toString('hex');
        decryptSecret(validPayload, wrongKey);
        expect.unreachable('Should have thrown');
      } catch (err: unknown) {
        const error = err as Error;
        expect(error.message).not.toContain(validPlaintext);
      }
    });
  });
});
