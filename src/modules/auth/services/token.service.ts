import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { ResponseCode } from '../../../common/constants/response-codes.js';
import { AppException } from '../../../common/exceptions/app.exception.js';
import { CryptoUtil } from '../../../common/utils/crypto.util.js';
import { PrismaService } from '../../../database/prisma.service.js';
import type {
  AccessTokenPayload,
  RefreshTokenPayload,
} from '../../../common/interfaces/authenticated-user.interface.js';
import { UserRole } from '../../../generated/prisma/enums.js';
import {
  ADMIN_PERMISSIONS_RESOLVER,
  type AdminPermissionsResolver,
} from '../../admin/admin-permissions.provider.js';
import type { AuthTokensDto } from '../dto/auth-response.dto.js';
import type { DeviceInfoDto } from '../dto/auth-request.dto.js';

interface SessionContext {
  device?: DeviceInfoDto;
  ipAddress?: string;
  userAgent?: string;
}

/** `15m` / `30d` / `900` → seconds. */
export function parseDurationToSeconds(input: string): number {
  const match = /^(\d+)\s*([smhd])?$/.exec(input.trim());
  if (!match) return Number(input) || 0;
  const value = Number(match[1]);
  switch (match[2]) {
    case 'd':
      return value * 86_400;
    case 'h':
      return value * 3_600;
    case 'm':
      return value * 60;
    default:
      return value;
  }
}

/**
 * Issues and rotates the token pair.
 *
 * Refresh tokens are single-use and belong to a family. Presenting a token that
 * was already exchanged (or was revoked) means it leaked, so the entire family
 * is revoked and the user must sign in again — the standard defence against a
 * stolen refresh token being replayed.
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(ADMIN_PERMISSIONS_RESOLVER)
    private readonly resolvePermissions?: AdminPermissionsResolver,
  ) {}

  private get accessTtlSeconds(): number {
    return parseDurationToSeconds(this.config.get<string>('jwt.accessExpiresIn', '15m'));
  }

  private get refreshTtlSeconds(): number {
    return parseDurationToSeconds(this.config.get<string>('jwt.refreshExpiresIn', '30d'));
  }

  /**
   * Creates a session (and registers the device) then issues the first pair.
   *
   * `permissions` is passed in rather than looked up here, so this service
   * stays ignorant of the back office.
   */
  async createSession(
    user: { id: string; role: UserRole; permissions?: string[] },
    context: SessionContext = {},
  ): Promise<{ tokens: AuthTokensDto; sessionId: string }> {
    const deviceId = context.device ? await this.upsertDevice(user.id, context.device) : null;

    const session = await this.prisma.userSession.create({
      data: {
        userId: user.id,
        deviceId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      },
      select: { id: true },
    });

    const tokens = await this.issuePair(
      { ...user, permissions: user.permissions ?? (await this.permissionsFor(user.id, user.role)) },
      session.id,
      randomUUID(),
    );

    return { tokens, sessionId: session.id };
  }

  async rotate(refreshToken: string, context: SessionContext = {}): Promise<AuthTokensDto> {
    const payload = await this.verifyRefreshToken(refreshToken);
    const tokenHash = CryptoUtil.sha256(refreshToken);

    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        sessionId: true,
        familyId: true,
        revokedAt: true,
        expiresAt: true,
        user: { select: { id: true, role: true, status: true, deletedAt: true } },
      },
    });

    // A signature-valid token we have never stored, or one already exchanged,
    // means the token leaked. Burn the whole family.
    if (!existing || existing.revokedAt) {
      await this.revokeFamily(payload.fid);
      this.logger.warn(`Refresh token reuse detected for family ${payload.fid}`);
      throw AppException.unauthorized(ResponseCode.REFRESH_TOKEN_REUSED);
    }

    if (existing.expiresAt.getTime() <= Date.now()) {
      throw AppException.unauthorized(ResponseCode.REFRESH_TOKEN_EXPIRED);
    }

    if (existing.user.deletedAt || existing.user.status === 'SUSPENDED' || existing.user.status === 'DEACTIVATED') {
      await this.revokeFamily(existing.familyId);
      throw AppException.forbidden(ResponseCode.ACCOUNT_SUSPENDED);
    }

    const tokens = await this.issuePair(
      {
        id: existing.user.id,
        role: existing.user.role,
        // Re-read on every rotation, so a role change reaches the dashboard
        // at the next refresh rather than at the next sign-in.
        permissions: await this.permissionsFor(existing.user.id, existing.user.role),
      },
      existing.sessionId,
      existing.familyId,
      existing.id,
    );

    await this.prisma.userSession.update({
      where: { id: existing.sessionId },
      data: { lastSeenAt: new Date(), ipAddress: context.ipAddress ?? undefined },
    });

    return tokens;
  }

  async revokeSession(sessionId: string): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.refreshToken.updateMany({
        where: { sessionId, revokedAt: null },
        data: { revokedAt: now },
      }),
      this.prisma.userSession.update({ where: { id: sessionId }, data: { revokedAt: now } }),
    ]);
  }

  async revokeAllSessions(userId: string): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } }),
      this.prisma.userSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } }),
    ]);
  }

  async revokeByRefreshToken(refreshToken: string): Promise<void> {
    const tokenHash = CryptoUtil.sha256(refreshToken);
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      select: { sessionId: true },
    });
    if (record) await this.revokeSession(record.sessionId);
  }

  async verifyRefreshToken(token: string): Promise<RefreshTokenPayload> {
    try {
      const payload = await this.jwt.verifyAsync<RefreshTokenPayload>(token, {
        secret: this.config.getOrThrow<string>('jwt.refreshSecret'),
        issuer: this.config.get<string>('jwt.issuer'),
      });
      if (payload.typ !== 'refresh') {
        throw AppException.unauthorized(ResponseCode.REFRESH_TOKEN_INVALID);
      }
      return payload;
    } catch (error) {
      if (error instanceof AppException) throw error;
      throw AppException.unauthorized(ResponseCode.REFRESH_TOKEN_INVALID);
    }
  }

  private async issuePair(
    user: { id: string; role: UserRole; permissions?: string[] },
    sessionId: string,
    familyId: string,
    replacesTokenId?: string,
  ): Promise<AuthTokensDto> {
    const jti = randomUUID();

    const accessPayload: AccessTokenPayload = {
      sub: user.id,
      role: user.role,
      sid: sessionId,
      typ: 'access',
      ...(user.permissions ? { permissions: user.permissions } : {}),
    };
    const refreshPayload: RefreshTokenPayload = {
      sub: user.id,
      sid: sessionId,
      fid: familyId,
      jti,
      typ: 'refresh',
    };

    const issuer = this.config.get<string>('jwt.issuer');

    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(accessPayload, {
        secret: this.config.getOrThrow<string>('jwt.accessSecret'),
        expiresIn: this.accessTtlSeconds,
        issuer,
      }),
      this.jwt.signAsync(refreshPayload, {
        secret: this.config.getOrThrow<string>('jwt.refreshSecret'),
        expiresIn: this.refreshTtlSeconds,
        issuer,
      }),
    ]);

    const created = await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        sessionId,
        familyId,
        tokenHash: CryptoUtil.sha256(refreshToken),
        expiresAt: new Date(Date.now() + this.refreshTtlSeconds * 1000),
      },
      select: { id: true },
    });

    if (replacesTokenId) {
      await this.prisma.refreshToken.update({
        where: { id: replacesTokenId },
        data: { revokedAt: new Date(), replacedById: created.id },
      });
    }

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.accessTtlSeconds,
    };
  }

  private async permissionsFor(userId: string, role: UserRole): Promise<string[] | undefined> {
    if (role !== UserRole.ADMIN || !this.resolvePermissions) return undefined;
    return this.resolvePermissions(userId);
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async upsertDevice(userId: string, device: DeviceInfoDto): Promise<string> {
    const record = await this.prisma.device.upsert({
      where: { userId_installationId: { userId, installationId: device.installationId } },
      create: {
        userId,
        installationId: device.installationId,
        platform: device.platform,
        model: device.model,
        osVersion: device.osVersion,
        appVersion: device.appVersion,
        locale: device.locale,
      },
      update: {
        platform: device.platform,
        model: device.model,
        osVersion: device.osVersion,
        appVersion: device.appVersion,
        locale: device.locale,
        lastSeenAt: new Date(),
      },
      select: { id: true },
    });

    if (device.pushToken) {
      await this.prisma.devicePushToken.upsert({
        where: { token: device.pushToken },
        create: { deviceId: record.id, token: device.pushToken },
        update: { deviceId: record.id, isActive: true, lastUsedAt: new Date() },
      });
    }

    return record.id;
  }
}
