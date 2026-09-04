import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { catchError, from, map, of, switchMap, throwError, type Observable } from 'rxjs';
import { METADATA_KEY } from '../constants/app.constants.js';
import { ResponseCode } from '../constants/response-codes.js';
import { AppException } from '../exceptions/app.exception.js';
import type { AuthenticatedUser } from '../interfaces/authenticated-user.interface.js';
import { CryptoUtil } from '../utils/crypto.util.js';
import { PrismaService } from '../../database/prisma.service.js';

const HEADER = 'idempotency-key';
const MAX_KEY_LENGTH = 128;

/** How long a key is honoured. Long enough to cover a retry, not a habit. */
const TTL_HOURS = 24;

/**
 * Makes marked endpoints safe to retry.
 *
 * A phone on a bad connection retries; a user taps *Book* twice because
 * nothing visibly happened. Without this, both produce two deliveries and two
 * charges. With a key, the second request returns the first one's response and
 * changes nothing.
 *
 * The reservation is an insert against a unique index, so two simultaneous
 * requests race in the database rather than in application code: exactly one
 * creates the row and proceeds, and the other is told the first is still
 * running. A request that fails releases its key, because a booking that
 * errored should be retryable rather than permanently poisoned.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const enabled = this.reflector.getAllAndOverride<boolean | undefined>(METADATA_KEY.IDEMPOTENT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!enabled) return next.handle();

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const key = request.headers[HEADER];
    const userId = request.user?.userId;

    // No key, or nobody to attribute it to: behave exactly as before.
    if (typeof key !== 'string' || key.length === 0 || !userId) return next.handle();

    if (key.length > MAX_KEY_LENGTH) {
      return throwError(() =>
        AppException.badRequest(
          ResponseCode.VALIDATION_ERROR,
          `Idempotency-Key must be at most ${MAX_KEY_LENGTH} characters.`,
        ),
      );
    }

    const endpoint = `${request.method} ${request.route?.path ?? request.path}`;
    const requestHash = CryptoUtil.sha256(JSON.stringify(request.body ?? {}));

    return from(this.reserve(userId, key, endpoint, requestHash)).pipe(
      switchMap((replay) => (replay ? of(replay.body) : this.run(context, next, userId, key, endpoint))),
    );
  }

  /**
   * Claims the key, or returns the response to replay.
   *
   * Returning `null` means this request owns the key and should proceed.
   */
  private async reserve(
    userId: string,
    key: string,
    endpoint: string,
    requestHash: string,
  ): Promise<{ body: unknown } | null> {
    try {
      await this.prisma.idempotencyKey.create({
        data: {
          key,
          userId,
          endpoint,
          requestHash,
          expiresAt: new Date(Date.now() + TTL_HOURS * 3_600_000),
        },
      });
      return null;
    } catch {
      // The unique index rejected it, so someone got here first.
      const existing = await this.prisma.idempotencyKey.findUnique({
        where: { userId_key_endpoint: { userId, key, endpoint } },
        select: { requestHash: true, statusCode: true, responseBody: true, completedAt: true },
      });

      if (!existing) {
        // Expired and pruned between the insert and the read; let it through.
        return null;
      }

      if (existing.requestHash !== requestHash) {
        throw AppException.conflict(
          ResponseCode.IDEMPOTENCY_KEY_REUSED,
          'This idempotency key was already used for a different request.',
        );
      }

      if (!existing.completedAt) {
        throw AppException.conflict(
          ResponseCode.IDEMPOTENCY_REQUEST_IN_PROGRESS,
          'An identical request is still being processed. Retry in a moment.',
        );
      }

      this.logger.log(`Replayed ${endpoint} for key ${key}`);
      return { body: existing.responseBody };
    }
  }

  private run(
    context: ExecutionContext,
    next: CallHandler,
    userId: string,
    key: string,
    endpoint: string,
  ): Observable<unknown> {
    const response = context.switchToHttp().getResponse<Response>();

    return next.handle().pipe(
      map((payload: unknown) => {
        // Recorded after the fact, so a replay returns what the caller got.
        // Failure to record must not fail the request the user just made.
        void this.prisma.idempotencyKey
          .update({
            where: { userId_key_endpoint: { userId, key, endpoint } },
            data: {
              statusCode: response.statusCode,
              responseBody: (payload ?? null) as never,
              completedAt: new Date(),
            },
          })
          .catch((error: unknown) => {
            this.logger.error(`Could not record idempotent response for ${endpoint}: ${String(error)}`);
          });

        return payload;
      }),
      catchError((error: unknown) => {
        // A failed attempt releases the key: a booking that errored should be
        // retryable, not permanently poisoned by its own failure.
        void this.prisma.idempotencyKey
          .deleteMany({ where: { userId, key, endpoint, completedAt: null } })
          .catch(() => undefined);

        return throwError(() => error);
      }),
    );
  }
}
