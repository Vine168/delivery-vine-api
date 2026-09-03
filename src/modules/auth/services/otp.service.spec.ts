import { beforeEach, describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { AppException } from '../../../common/exceptions/app.exception.js';
import { ResponseCode } from '../../../common/constants/response-codes.js';
import { OtpChannel, OtpPurpose, UserRole } from '../../../generated/prisma/enums.js';
import type { PrismaService } from '../../../database/prisma.service.js';
import type { RedisService } from '../../../redis/redis.service.js';
import { OtpService } from './otp.service.js';
import type { OtpMessage, OtpSender } from './otp-sender.interface.js';

/** In-memory stand-in for the pieces of RedisService the OTP flow touches. */
function createFakeRedis() {
  const store = new Map<string, { value: string; expiresAt: number }>();

  const live = (key: string) => {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      store.delete(key);
      return null;
    }
    return entry;
  };

  return {
    store,
    async setJson(key: string, value: unknown, ttl = 300) {
      store.set(key, { value: JSON.stringify(value), expiresAt: Date.now() + ttl * 1000 });
    },
    async getJson<T>(key: string): Promise<T | null> {
      const entry = live(key);
      return entry ? (JSON.parse(entry.value) as T) : null;
    },
    async ttl(key: string) {
      const entry = live(key);
      return entry ? Math.ceil((entry.expiresAt - Date.now()) / 1000) : -2;
    },
    async incrementWithTtl(key: string, ttl: number) {
      const entry = live(key);
      const next = entry ? Number(entry.value) + 1 : 1;
      store.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? Date.now() + ttl * 1000 });
      return next;
    },
    client: {
      async set(key: string, value: string, _mode: string, ttl: number) {
        store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
        return 'OK';
      },
      async del(key: string) {
        return store.delete(key) ? 1 : 0;
      },
    },
  };
}

function createFakePrisma() {
  const rows = new Map<string, Record<string, unknown>>();
  let sequence = 0;

  return {
    rows,
    otpVerification: {
      async create({ data }: { data: Record<string, unknown> }) {
        const id = `otp_${++sequence}`;
        rows.set(id, { id, ...data });
        return { id };
      },
      async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
        const existing = rows.get(where.id) ?? {};
        const updated = { ...existing, ...data };
        rows.set(where.id, updated);
        return updated;
      },
    },
  };
}

const CONFIG: Record<string, unknown> = {
  'otp.ttlSeconds': 300,
  'otp.resendCooldownSeconds': 60,
  'otp.maxPerHour': 3,
  'otp.length': 6,
  'otp.maxAttempts': 3,
  'otp.verificationTokenTtlSeconds': 900,
  'otp.exposeInResponse': false,
};

describe('OtpService', () => {
  let redis: ReturnType<typeof createFakeRedis>;
  let prisma: ReturnType<typeof createFakePrisma>;
  let sent: OtpMessage[];
  let service: OtpService;

  const subject = {
    identifier: '+85512345678',
    purpose: OtpPurpose.REGISTRATION,
    role: UserRole.CUSTOMER,
  };

  beforeEach(() => {
    redis = createFakeRedis();
    prisma = createFakePrisma();
    sent = [];

    const sender: OtpSender = {
      async send(message) {
        sent.push(message);
      },
    };

    const config = {
      get: <T>(key: string, fallback?: T) => (CONFIG[key] as T) ?? fallback,
    } as unknown as ConfigService;

    service = new OtpService(
      redis as unknown as RedisService,
      prisma as unknown as PrismaService,
      config,
      sender,
    );
  });

  const issue = () =>
    service.issue({ ...subject, channel: OtpChannel.SMS, ipAddress: '127.0.0.1' });

  describe('issue', () => {
    it('sends a code of the configured length and returns when a resend is allowed', async () => {
      const challenge = await issue();

      expect(sent).toHaveLength(1);
      expect(sent[0].code).toMatch(/^\d{6}$/);
      expect(challenge.resendAfterSeconds).toBe(60);
      expect(challenge.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('never stores or returns the plaintext code', async () => {
      const challenge = await issue();
      const code = sent[0].code;

      expect(challenge.debugCode).toBeUndefined();
      const persisted = [...prisma.rows.values()][0];
      expect(persisted.codeHash).not.toBe(code);
      expect(JSON.stringify([...redis.store.values()])).not.toContain(code);
    });

    it('refuses a second request inside the cooldown window', async () => {
      await issue();
      await expect(issue()).rejects.toMatchObject({ code: ResponseCode.OTP_RESEND_TOO_SOON });
    });

    it('enforces the hourly budget once the cooldown is cleared', async () => {
      for (let i = 0; i < 3; i++) {
        await issue();
        redis.store.delete(`otp:cooldown:${subject.purpose}:${subject.role}:${subject.identifier}`);
      }

      await expect(issue()).rejects.toMatchObject({ code: ResponseCode.OTP_RATE_LIMITED });
    });
  });

  describe('verify', () => {
    it('accepts the correct code and returns a verification token', async () => {
      await issue();
      const result = await service.verify(subject, sent[0].code);

      expect(result.token).toBeTruthy();
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('consumes the code, so it cannot be replayed', async () => {
      await issue();
      const code = sent[0].code;
      await service.verify(subject, code);

      await expect(service.verify(subject, code)).rejects.toMatchObject({
        code: ResponseCode.OTP_EXPIRED,
      });
    });

    it('rejects a wrong code without consuming the challenge', async () => {
      await issue();
      const wrong = sent[0].code === '000000' ? '111111' : '000000';

      await expect(service.verify(subject, wrong)).rejects.toMatchObject({
        code: ResponseCode.OTP_INVALID,
      });

      // the real code still works afterwards
      await expect(service.verify(subject, sent[0].code)).resolves.toBeTruthy();
    });

    it('burns the challenge after the configured number of wrong attempts', async () => {
      await issue();
      const wrong = sent[0].code === '000000' ? '111111' : '000000';

      await expect(service.verify(subject, wrong)).rejects.toMatchObject({ code: ResponseCode.OTP_INVALID });
      await expect(service.verify(subject, wrong)).rejects.toMatchObject({ code: ResponseCode.OTP_INVALID });
      await expect(service.verify(subject, wrong)).rejects.toMatchObject({
        code: ResponseCode.OTP_MAX_ATTEMPTS_REACHED,
      });

      // even the correct code is now useless
      await expect(service.verify(subject, sent[0].code)).rejects.toMatchObject({
        code: ResponseCode.OTP_EXPIRED,
      });
    });

    it('does not accept a code issued for a different purpose or role', async () => {
      await issue();
      const code = sent[0].code;

      await expect(
        service.verify({ ...subject, purpose: OtpPurpose.PASSWORD_RESET }, code),
      ).rejects.toMatchObject({ code: ResponseCode.OTP_EXPIRED });

      await expect(service.verify({ ...subject, role: UserRole.DRIVER }, code)).rejects.toMatchObject({
        code: ResponseCode.OTP_EXPIRED,
      });
    });
  });

  describe('consumeVerificationToken', () => {
    it('accepts the token exactly once', async () => {
      await issue();
      const { token } = await service.verify(subject, sent[0].code);

      await expect(service.consumeVerificationToken(subject, token)).resolves.toBeUndefined();
      await expect(service.consumeVerificationToken(subject, token)).rejects.toMatchObject({
        code: ResponseCode.VERIFICATION_TOKEN_INVALID,
      });
    });

    it('rejects a token minted for another subject', async () => {
      await issue();
      const { token } = await service.verify(subject, sent[0].code);

      await expect(
        service.consumeVerificationToken({ ...subject, role: UserRole.DRIVER }, token),
      ).rejects.toBeInstanceOf(AppException);
    });

    it('rejects a fabricated token', async () => {
      await expect(service.consumeVerificationToken(subject, 'not-a-real-token')).rejects.toMatchObject({
        code: ResponseCode.VERIFICATION_TOKEN_INVALID,
      });
    });
  });
});
