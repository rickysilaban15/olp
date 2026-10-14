import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

/**
 * Format prefix untuk payload terenkripsi AES-256-GCM.
 * Format: v1:<iv_hex_12bytes>:<auth_tag_hex_16bytes>:<ciphertext_hex>
 */
export const CIPHER_VERSION = 'v1';
export const KEY_BYTE_LENGTH = 32; // 256 bit
export const IV_BYTE_LENGTH = 12;  // 96 bit untuk AES-GCM
export const AUTH_TAG_BYTE_LENGTH = 16; // 128 bit

export class SecretCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretCryptoError';
  }
}

/**
 * Memvalidasi dan menormalisasi kunci master AES-256 (32 bytes).
 * Menerima string hex 64 karakter atau Buffer 32 byte.
 * DILARANG mencatat nilai kunci ke log.
 */
export function validateMasterKey(rawKey: string | Buffer | undefined | null): Buffer {
  if (!rawKey) {
    throw new SecretCryptoError('Master key is missing or undefined.');
  }

  if (Buffer.isBuffer(rawKey)) {
    if (rawKey.length !== KEY_BYTE_LENGTH) {
      throw new SecretCryptoError(`Invalid master key buffer length: expected ${KEY_BYTE_LENGTH} bytes, got ${rawKey.length}`);
    }
    return rawKey;
  }

  if (typeof rawKey === 'string') {
    const trimmed = rawKey.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      throw new SecretCryptoError(
        `Invalid master key format: expected 64-character hexadecimal string (${KEY_BYTE_LENGTH * 2} hex chars), got length ${trimmed.length}`
      );
    }
    return Buffer.from(trimmed, 'hex');
  }

  throw new SecretCryptoError('Master key must be a 64-character hex string or a 32-byte Buffer.');
}

/**
 * Menyelesaikan kunci master dari environment atau file terisolasi.
 * Prioritas:
 * 1. env['OLP_MASTER_KEY'] (string heksadesimal 64 karakter)
 * 2. env['OLP_MASTER_KEY_FILE'] (path file host dengan izin ketat 0400)
 */
export function resolveMasterKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const directKey = env['OLP_MASTER_KEY'];
  if (directKey && directKey.trim() !== '') {
    return validateMasterKey(directKey);
  }

  const keyFilePath = env['OLP_MASTER_KEY_FILE'];
  if (keyFilePath && keyFilePath.trim() !== '') {
    if (!existsSync(keyFilePath)) {
      throw new SecretCryptoError(`Master key file not found at path: ${keyFilePath}`);
    }
    try {
      const content = readFileSync(keyFilePath, 'utf8').trim();
      return validateMasterKey(content);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SecretCryptoError(`Failed to read master key file: ${msg}`);
    }
  }

  throw new SecretCryptoError(
    'No master key configured. Please set OLP_MASTER_KEY or OLP_MASTER_KEY_FILE in your environment.'
  );
}

/**
 * Mengenkripsi plaintext menggunakan AES-256-GCM.
 * Menghasilkan IV acak unik 12 bytes untuk setiap operasi enkripsi.
 * Format output: v1:<iv_hex>:<tag_hex>:<ciphertext_hex>
 */
export function encryptSecret(plaintext: string, rawKey: string | Buffer): string {
  if (typeof plaintext !== 'string') {
    throw new SecretCryptoError('Plaintext must be a string.');
  }

  const key = validateMasterKey(rawKey);
  const iv = randomBytes(IV_BYTE_LENGTH);

  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final()
    ]);
    const authTag = cipher.getAuthTag();

    if (authTag.length !== AUTH_TAG_BYTE_LENGTH) {
      throw new SecretCryptoError(`Unexpected auth tag length: ${authTag.length}`);
    }

    return `${CIPHER_VERSION}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  } catch (err: unknown) {
    if (err instanceof SecretCryptoError) throw err;
    throw new SecretCryptoError('Encryption operation failed.');
  }
}

/**
 * Mendekripsi payload AES-256-GCM yang berformat v1:<iv_hex>:<tag_hex>:<ciphertext_hex>.
 * Menolak payload yang diubah (tampered), kunci yang salah, atau format rusak.
 */
export function decryptSecret(payload: string, rawKey: string | Buffer): string {
  if (typeof payload !== 'string' || payload.trim() === '') {
    throw new SecretCryptoError('Encrypted payload must be a non-empty string.');
  }

  const key = validateMasterKey(rawKey);
  const parts = payload.split(':');

  if (parts.length !== 4 || parts[0] !== CIPHER_VERSION) {
    throw new SecretCryptoError(
      `Invalid encrypted payload format: expected '${CIPHER_VERSION}:<iv>:<tag>:<ciphertext>'`
    );
  }

  const [, ivHex, tagHex, cipherHex] = parts;

  if (!ivHex || !tagHex || cipherHex === undefined) {
    throw new SecretCryptoError('Malformed encrypted payload structure.');
  }

  // Validasi karakter hex
  if (!/^[0-9a-fA-F]+$/.test(ivHex) || !/^[0-9a-fA-F]+$/.test(tagHex)) {
    throw new SecretCryptoError('IV and auth tag must be valid hexadecimal strings.');
  }
  if (cipherHex.length > 0 && !/^[0-9a-fA-F]+$/.test(cipherHex)) {
    throw new SecretCryptoError('Ciphertext must be a valid hexadecimal string.');
  }

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(tagHex, 'hex');
  const ciphertext = Buffer.from(cipherHex, 'hex');

  if (iv.length !== IV_BYTE_LENGTH) {
    throw new SecretCryptoError(`Invalid IV length: expected ${IV_BYTE_LENGTH} bytes, got ${iv.length}`);
  }
  if (authTag.length !== AUTH_TAG_BYTE_LENGTH) {
    throw new SecretCryptoError(`Invalid auth tag length: expected ${AUTH_TAG_BYTE_LENGTH} bytes, got ${authTag.length}`);
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);
    return decrypted.toString('utf8');
  } catch (_err: unknown) {
    // Pesan error umum agar tidak membocorkan detail internal kriptografi
    throw new SecretCryptoError(
      'Decryption failed: authentication tag mismatch or corrupted ciphertext.'
    );
  }
}
