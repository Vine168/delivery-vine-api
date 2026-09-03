import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { METADATA_KEY } from '../constants/app.constants.js';
import { RedisKey } from '../constants/redis-keys.js';
import { ResponseCode } from '../constants/response-codes.js';
import { AppException } from '../exceptions/app.exception.js';
import { RedisService } from '../../redis/redis.service.js';
import type { AuthenticatedUser } from '../interfaces/authenticated-user.interface.js';
import type { RateLimitOptions } from '../decorators/rate-limit.decorator.js';

/**
 * Redis fixed-window rate limiting, applied per route via `@RateLimit(...)`.
 *
 * Written in-house rather than pulled from @nestjs/throttler: the OTP endpoints
 * need budgets keyed by phone number as well as IP, and the throttler package
 * does not yet support NestJS 12.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(METADATA_KEY.RATE_LIMIT, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!options) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const subject = this.subjectFor(options, request);
    const key = RedisKey.rateLimit(options.bucket, subject);

    const count = await this.redis.incrementWithTtl(key, options.windowSeconds);

    if (count > options.limit) {
      const retryAfter = await this.redis.ttl(key);
      throw AppException.tooManyRequests(
        ResponseCode.RATE_LIMIT_EXCEEDED,
        undefined,
        retryAfter > 0 ? retryAfter : options.windowSeconds,
      );
    }

    return true;
  }

  private subjectFor(options: RateLimitOptions, request: Request & { user?: AuthenticatedUser }): string {
    const ip = request.ip ?? request.socket.remoteAddress ?? 'unknown';
    const userId = request.user?.userId;

    switch (options.by) {
      case 'user':
        return userId ?? ip;
      case 'ip+user':
        return `${ip}:${userId ?? 'anon'}`;
      default:
        return ip;
    }
  }
}
