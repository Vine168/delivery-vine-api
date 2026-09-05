import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisKey } from '../../../common/constants/redis-keys.js';
import { ResponseCode } from '../../../common/constants/response-codes.js';
import { AppException } from '../../../common/exceptions/app.exception.js';
import type { UserRole } from '../../../generated/prisma/enums.js';
import { RedisService } from '../../../redis/redis.service.js';

/**
 * Counts failed sign-ins against one account and locks it out.
 *
 * The rate limit on the login route is keyed by IP, which stops one machine
 * hammering the API but does nothing to protect a *particular* account: an
 * attacker with a hundred addresses gets a hundred budgets against the same
 * phone number. Nothing counted failures against the account itself, so a
 * targeted guess had no ceiling at all.
 *
 * The key is the account, not the person. One phone number holds a separate
 * customer, driver and back-office account, and they lock independently —
 * otherwise anyone could lock a driver out of earning simply by guessing at
 * their customer password.
 */
@Injectable()
export class LoginAttemptsService {
  private readonly logger = new Logger(LoginAttemptsService.name);

  private readonly maxAttempts: number;
  private readonly windowSeconds: number;
  private readonly lockSeconds: number;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.maxAttempts = config.get<number>('auth.maxLoginAttempts', 10);
    this.windowSeconds = config.get<number>('auth.loginAttemptWindowSeconds', 900);
    this.lockSeconds = config.get<number>('auth.loginLockSeconds', 900);
  }

  /**
   * Refuses early when an account is locked.
   *
   * Called before the password is checked, so a locked account costs an
   * attacker a request and tells them nothing about the password.
   */
  async assertNotLocked(phone: string, role: UserRole): Promise<void> {
    const remaining = await this.redis.client.ttl(this.lockKey(phone, role));

    if (remaining > 0) {
      throw AppException.tooManyRequests(
        ResponseCode.ACCOUNT_TEMPORARILY_LOCKED,
        `Too many failed sign-in attempts. Try again in ${Math.ceil(remaining / 60)} minute(s).`,
        remaining,
      );
    }
  }

  /**
   * Records a failure and locks the account once there have been too many.
   *
   * Counted for accounts that do not exist as well, so probing for valid
   * numbers looks exactly like guessing a password.
   */
  async recordFailure(phone: string, role: UserRole): Promise<void> {
    const failures = await this.redis.incrementWithTtl(this.attemptsKey(phone, role), this.windowSeconds);

    if (failures >= this.maxAttempts) {
      await this.redis.client.set(this.lockKey(phone, role), '1', 'EX', this.lockSeconds);
      await this.redis.client.del(this.attemptsKey(phone, role));

      // Worth a log line: a locked account is either an attack or a user who
      // needs help, and both are things somebody should be able to see.
      this.logger.warn(`Locked ${role} account ${this.mask(phone)} after ${failures} failed attempts`);
    }
  }

  /** A successful sign-in clears the slate. */
  async recordSuccess(phone: string, role: UserRole): Promise<void> {
    await this.redis.client.del(this.attemptsKey(phone, role), this.lockKey(phone, role));
  }

  private attemptsKey(phone: string, role: UserRole): string {
    return RedisKey.loginFailures(role, phone);
  }

  private lockKey(phone: string, role: UserRole): string {
    return RedisKey.loginLock(role, phone);
  }

  private mask(phone: string): string {
    return phone.length <= 8 ? '***' : `${phone.slice(0, 5)}****${phone.slice(-3)}`;
  }
}
