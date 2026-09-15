import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ResponseCode } from '../../../common/constants/response-codes.js';
import { RedisKey } from '../../../common/constants/redis-keys.js';
import { AppException } from '../../../common/exceptions/app.exception.js';
import { CryptoUtil } from '../../../common/utils/crypto.util.js';
import { PrismaService } from '../../../database/prisma.service.js';
import { RedisService } from '../../../redis/redis.service.js';
import type { OtpChannel, OtpPurpose, UserRole } from '../../../generated/prisma/enums.js';
import { OTP_SENDER, type OtpSender } from './otp-sender.interface.js';

interface OtpSubject {
  identifier: string;
  purpose: OtpPurpose;
  role: UserRole;
}

interface IssueOtpInput extends OtpSubject {
  channel: OtpChannel;
  ipAddress?: string;
}

export interface OtpChallenge {
  expiresAt: Date;
  resendAfterSeconds: number;
  debugCode?: string;
}

/** Attempts live under their own key, so they can be counted atomically. */
interface StoredOtp {
  codeHash: string;
  recordId: string;
}

/**
 * OTP lifecycle.
 *
 * The live code lives in Redis with a TTL — that is what makes expiry exact and
 * keeps the hot path off Postgres. Only a hash is ever stored, in either place,
 * so a database or cache dump cannot be replayed. Every issuance is also
 * written to `OtpVerification` as an audit trail.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(OTP_SENDER) private readonly sender: OtpSender,
  ) {}

  private subjectKey(subject: OtpSubject): string {
    return `${subject.role}:${subject.identifier}`;
  }

  private hashCode(code: string, subject: OtpSubject): string {
    return CryptoUtil.sha256(`${code}:${subject.purpose}:${this.subjectKey(subject)}`);
  }

  /**
   * Issues a code, enforcing both a short resend cooldown and an hourly budget
   * per (identifier, purpose). Returns when the client may ask again.
   */
  async issue(input: IssueOtpInput): Promise<OtpChallenge> {
    const ttlSeconds = this.config.get<number>('otp.ttlSeconds', 300);
    const cooldownSeconds = this.config.get<number>('otp.resendCooldownSeconds', 60);
    const maxPerHour = this.config.get<number>('otp.maxPerHour', 5);
    const length = this.config.get<number>('otp.length', 6);
    const maxAttempts = this.config.get<number>('otp.maxAttempts', 5);

    const subjectKey = this.subjectKey(input);
    const cooldownKey = RedisKey.otpResendCooldown(input.purpose, subjectKey);
    const hourlyKey = RedisKey.otpHourlyCounter(input.purpose, subjectKey);
    const otpKey = RedisKey.otpCode(input.purpose, subjectKey);

    // Claimed up front with NX, not checked now and set after sending: two taps
    // on "resend" would otherwise both get through and send two different
    // codes, and the person would type whichever arrived first and be told it
    // was wrong.
    const claimed = await this.redis.client.set(cooldownKey, '1', 'EX', cooldownSeconds, 'NX');
    if (!claimed) {
      const remainingCooldown = Math.max(await this.redis.ttl(cooldownKey), 1);
      throw AppException.tooManyRequests(
        ResponseCode.OTP_RESEND_TOO_SOON,
        `Please wait ${remainingCooldown} seconds before requesting another code.`,
        remainingCooldown,
      );
    }

    const sentThisHour = await this.redis.incrementWithTtl(hourlyKey, 3600);
    if (sentThisHour > maxPerHour) {
      const retryAfter = await this.redis.ttl(hourlyKey);
      throw AppException.tooManyRequests(
        ResponseCode.OTP_RATE_LIMITED,
        undefined,
        retryAfter > 0 ? retryAfter : 3600,
      );
    }

    const code = CryptoUtil.randomNumericCode(length);
    const codeHash = this.hashCode(code, input);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    const record = await this.prisma.otpVerification.create({
      data: {
        identifier: input.identifier,
        channel: input.channel,
        purpose: input.purpose,
        codeHash,
        maxAttempts,
        expiresAt,
        ipAddress: input.ipAddress,
      },
      select: { id: true },
    });

    const stored: StoredOtp = { codeHash, recordId: record.id };
    await this.redis.setJson(otpKey, stored, ttlSeconds);
    // A new code starts with a full budget of attempts.
    await this.redis.client.del(RedisKey.otpAttempts(input.purpose, subjectKey));

    try {
      await this.sender.send({
        identifier: input.identifier,
        channel: input.channel,
        code,
        ttlSeconds,
      });
    } catch (error) {
      // The cooldown was claimed a moment ago to stop someone spamming codes.
      // If the code never actually left, that cooldown punishes them for our
      // failure — they would be told to wait for a message that is not coming.
      // So it is released, and the stored code with it, leaving them free to
      // ask again straight away.
      await this.redis.client.del(cooldownKey);
      await this.redis.client.del(otpKey);
      throw error;
    }

    const exposeCode = this.config.get<boolean>('otp.exposeInResponse', false);
    return {
      expiresAt,
      resendAfterSeconds: cooldownSeconds,
      ...(exposeCode ? { debugCode: code } : {}),
    };
  }

  /**
   * Verifies a code and, on success, returns a single-use token that the
   * following request (set-password / reset-password) must present. The code
   * itself is consumed immediately so it can never be replayed.
   */
  async verify(subject: OtpSubject, code: string): Promise<{ token: string; expiresAt: Date }> {
    const subjectKey = this.subjectKey(subject);
    const otpKey = RedisKey.otpCode(subject.purpose, subjectKey);
    const attemptsKey = RedisKey.otpAttempts(subject.purpose, subjectKey);

    const stored = await this.redis.getJson<StoredOtp>(otpKey);
    if (!stored) {
      throw AppException.badRequest(ResponseCode.OTP_EXPIRED);
    }

    // Counted atomically, before the code is compared, so the cap holds however
    // many guesses arrive at once. Reading a count and writing it back after
    // the comparison let every request in a parallel burst see the same count,
    // and each of them got a guess the cap was meant to refuse.
    const maxAttempts = this.config.get<number>('otp.maxAttempts', 5);
    const ttlSeconds = this.config.get<number>('otp.ttlSeconds', 300);
    const attempt = await this.redis.incrementWithTtl(attemptsKey, ttlSeconds);

    if (attempt > maxAttempts) {
      await this.redis.client.del(otpKey, attemptsKey);
      throw AppException.badRequest(ResponseCode.OTP_MAX_ATTEMPTS_REACHED);
    }

    if (!CryptoUtil.safeEqual(this.hashCode(code, subject), stored.codeHash)) {
      await this.recordAttempts(stored.recordId, attempt);

      if (attempt === maxAttempts) {
        await this.redis.client.del(otpKey, attemptsKey);
        throw AppException.badRequest(ResponseCode.OTP_MAX_ATTEMPTS_REACHED);
      }
      throw AppException.badRequest(ResponseCode.OTP_INVALID);
    }

    // Only the request that actually removes the code gets a token, so the
    // right code sent twice at once is still spent once.
    const consumed = await this.redis.client.del(otpKey);
    if (consumed === 0) {
      throw AppException.badRequest(ResponseCode.OTP_EXPIRED);
    }
    await this.redis.client.del(attemptsKey);

    const tokenTtl = this.config.get<number>('otp.verificationTokenTtlSeconds', 900);
    const token = CryptoUtil.randomToken(32);
    const tokenHash = CryptoUtil.sha256(token);
    const expiresAt = new Date(Date.now() + tokenTtl * 1000);

    await this.redis.setJson(
      RedisKey.otpVerificationToken(tokenHash),
      { subjectKey, purpose: subject.purpose, recordId: stored.recordId },
      tokenTtl,
    );

    await this.prisma.otpVerification.update({
      where: { id: stored.recordId },
      data: {
        verifiedAt: new Date(),
        // Failed attempts before this one, as the column has always recorded.
        attempts: attempt - 1,
        verificationTokenHash: tokenHash,
        verificationExpiresAt: expiresAt,
      },
    });

    return { token, expiresAt };
  }

  /**
   * Spends a verification token. Single use: the token is deleted before the
   * caller acts on it, so two concurrent password resets cannot both succeed.
   */
  async consumeVerificationToken(subject: OtpSubject, token: string): Promise<void> {
    const tokenHash = CryptoUtil.sha256(token);
    const key = RedisKey.otpVerificationToken(tokenHash);

    const stored = await this.redis.getJson<{ subjectKey: string; purpose: OtpPurpose; recordId: string }>(key);

    if (!stored || stored.subjectKey !== this.subjectKey(subject) || stored.purpose !== subject.purpose) {
      throw AppException.badRequest(ResponseCode.VERIFICATION_TOKEN_INVALID);
    }

    const deleted = await this.redis.client.del(key);
    if (deleted === 0) {
      throw AppException.badRequest(ResponseCode.VERIFICATION_TOKEN_INVALID);
    }

    await this.prisma.otpVerification.update({
      where: { id: stored.recordId },
      data: { consumedAt: new Date(), verificationTokenHash: null },
    });
  }

  private async recordAttempts(recordId: string, attempts: number): Promise<void> {
    await this.prisma.otpVerification
      .update({ where: { id: recordId }, data: { attempts } })
      .catch((error: unknown) => this.logger.warn(`Could not record OTP attempt: ${String(error)}`));
  }
}
