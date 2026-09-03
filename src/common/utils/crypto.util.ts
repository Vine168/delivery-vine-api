import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const SALT = 'deliver-field-encryption';

export const CryptoUtil = {
  /**
   * SHA-256 hex. Used for values we must look up by exact match but never read
   * back — refresh tokens, OTP codes, idempotency request bodies.
   */
  sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  },

  /** Constant-time comparison — never use `===` on a secret. */
  safeEqual(a: string, b: string): boolean {
    const bufferA = Buffer.from(a);
    const bufferB = Buffer.from(b);
    if (bufferA.length !== bufferB.length) return false;
    return timingSafeEqual(bufferA, bufferB);
  },

  randomToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  },

  /** Numeric OTP code of the requested length, uniform and unbiased. */
  randomNumericCode(length: number): string {
    let code = '';
    while (code.length < length) {
      // rejection sampling keeps the digit distribution uniform
      for (const byte of randomBytes(length)) {
        if (byte < 250) {
          code += String(byte % 10);
          if (code.length === length) break;
        }
      }
    }
    return code;
  },

  /**
   * Reversible field encryption for data we must display back to its owner
   * (bank account numbers). Not for passwords — those are Argon2 hashed.
   */
  encrypt(plaintext: string, key: string): string {
    const derivedKey = scryptSync(key, SALT, 32);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, derivedKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, encrypted]).toString('base64');
  },

  decrypt(payload: string, key: string): string {
    const derivedKey = scryptSync(key, SALT, 32);
    const buffer = Buffer.from(payload, 'base64');
    const iv = buffer.subarray(0, IV_BYTES);
    const authTag = buffer.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
    const encrypted = buffer.subarray(IV_BYTES + AUTH_TAG_BYTES);
    const decipher = createDecipheriv(ALGORITHM, derivedKey, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  },

  maskLast4(value: string): string {
    const digits = value.replace(/\D/g, '');
    return digits.slice(-4);
  },
};
