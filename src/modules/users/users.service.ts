import { Injectable } from '@nestjs/common';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import { PrismaService } from '../../database/prisma.service.js';
import { RedisService } from '../../redis/redis.service.js';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface.js';
import { UserRole, UserStatus } from '../../generated/prisma/enums.js';

const AUTH_CONTEXT_TTL_SECONDS = 60;

const authSelect = {
  id: true,
  phone: true,
  email: true,
  role: true,
  status: true,
  passwordHash: true,
  phoneVerifiedAt: true,
  deletedAt: true,
  customerProfile: { select: { id: true, fullName: true, avatarFileId: true } },
  driverProfile: { select: { id: true, fullName: true, avatarFileId: true, approvalStatus: true } },
} as const;

export type UserWithProfiles = NonNullable<Awaited<ReturnType<UsersService['findByPhoneAndRole']>>>;

/**
 * Reads and writes the User aggregate. Auth flows go through here so the rules
 * about status, soft deletion and profile shape live in one place.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  findByPhoneAndRole(phone: string, role: UserRole) {
    return this.prisma.user.findFirst({
      where: { phone, role, deletedAt: null },
      select: authSelect,
    });
  }

  findById(userId: string) {
    return this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: authSelect,
    });
  }

  /**
   * Resolves the principal for an authenticated request, cached briefly in
   * Redis so high-frequency endpoints (driver location pings) do not hit
   * Postgres on every call. Suspension takes effect immediately because
   * `invalidateAuthContext` is called wherever status changes.
   */
  async getAuthContext(userId: string, sessionId: string): Promise<AuthenticatedUser> {
    const cacheKey = `auth:ctx:${userId}:${sessionId}`;
    const cached = await this.redis.getJson<AuthenticatedUser>(cacheKey);
    if (cached) return cached;

    const [user, session] = await Promise.all([
      this.findById(userId),
      this.prisma.userSession.findUnique({
        where: { id: sessionId },
        select: { id: true, userId: true, revokedAt: true },
      }),
    ]);

    if (!user) {
      throw AppException.unauthorized(ResponseCode.ACCOUNT_NOT_FOUND);
    }
    if (!session || session.revokedAt || session.userId !== userId) {
      throw AppException.unauthorized(ResponseCode.REFRESH_TOKEN_INVALID, 'This session is no longer valid.');
    }

    this.assertUsable(user.status);

    const context: AuthenticatedUser = {
      userId: user.id,
      role: user.role,
      status: user.status,
      phone: user.phone,
      sessionId,
      customerId: user.customerProfile?.id,
      driverId: user.driverProfile?.id,
    };

    await this.redis.setJson(cacheKey, context, AUTH_CONTEXT_TTL_SECONDS);
    return context;
  }

  /** Drops every cached principal for a user — call after any status change. */
  async invalidateAuthContext(userId: string): Promise<void> {
    const prefix = this.redis.client.options.keyPrefix ?? '';
    const pattern = `${prefix}auth:ctx:${userId}:*`;
    const stream = this.redis.client.scanStream({ match: pattern, count: 100 });

    for await (const keys of stream as AsyncIterable<string[]>) {
      if (keys.length) {
        // scanStream yields prefixed keys; strip the prefix before deleting.
        await this.redis.client.del(...keys.map((key) => key.slice(prefix.length)));
      }
    }
  }

  assertUsable(status: UserStatus): void {
    switch (status) {
      case UserStatus.SUSPENDED:
        throw AppException.forbidden(ResponseCode.ACCOUNT_SUSPENDED);
      case UserStatus.DEACTIVATED:
        throw AppException.forbidden(ResponseCode.ACCOUNT_DEACTIVATED);
      case UserStatus.PENDING_VERIFICATION:
        throw AppException.forbidden(ResponseCode.ACCOUNT_NOT_VERIFIED);
      default:
        break;
    }
  }

  /** Frees the phone number for re-registration when an account is removed. */
  async softDelete(userId: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { phone: true, email: true },
    });
    const stamp = Date.now();

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        deletedAt: new Date(),
        status: UserStatus.DEACTIVATED,
        phone: `deleted:${stamp}:${user.phone}`,
        email: user.email ? `deleted:${stamp}:${user.email}` : null,
      },
    });

    await this.invalidateAuthContext(userId);
  }
}
