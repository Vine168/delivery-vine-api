import { Injectable } from '@nestjs/common';
import { RedisKey } from '../../../common/constants/redis-keys.js';
import { CryptoUtil } from '../../../common/utils/crypto.util.js';
import { RedisService } from '../../../redis/redis.service.js';

/** Long enough to change bank details and then withdraw; short enough to matter. */
const STEP_UP_TTL_SECONDS = 300;

/**
 * Short-lived proof that whoever holds a session has just re-entered the
 * password.
 *
 * Bound to the session, so a confirmation lifted from one phone opens nothing
 * on another. Stored hashed, and good for several actions inside its few
 * minutes rather than one: fixing bank details and then withdrawing is one
 * sitting, and asking twice would teach people to type it without thinking.
 */
@Injectable()
export class StepUpService {
  constructor(private readonly redis: RedisService) {}

  async issue(sessionId: string): Promise<{ stepUpToken: string; expiresAt: string }> {
    const token = CryptoUtil.randomToken(32);
    await this.redis.client.set(RedisKey.stepUp(sessionId), CryptoUtil.sha256(token), 'EX', STEP_UP_TTL_SECONDS);

    return {
      stepUpToken: token,
      expiresAt: new Date(Date.now() + STEP_UP_TTL_SECONDS * 1000).toISOString(),
    };
  }

  async verify(sessionId: string, token: string): Promise<boolean> {
    const stored = await this.redis.client.get(RedisKey.stepUp(sessionId));
    return stored !== null && CryptoUtil.safeEqual(stored, CryptoUtil.sha256(token));
  }
}
