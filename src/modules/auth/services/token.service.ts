import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { DomainEvent } from '../../../common/constants/events.js';
import { ResponseCode } from '../../../common/constants/response-codes.js';
import { AppException } from '../../../common/exceptions/app.exception.js';
import { CryptoUtil } from '../../../common/utils/crypto.util.js';
import { PrismaService } from '../../../database/prisma.service.js';
import type {
  AccessTokenPayload,
  RefreshTokenPayload,
} from '../../../common/interfaces/authenticated-user.interface.js';
import { type ClientApp, type DevicePlatform, UserRole } from '../../../generated/prisma/enums.js';
import {
  ADMIN_PERMISSIONS_RESOLVER,
  type AdminPermissionsResolver,
} from '../../admin/admin-permissions.provider.js';
import type { AuthTokensDto } from '../dto/auth-response.dto.js';
import type { DeviceInfoDto } from '../dto/auth-request.dto.js';

interface SessionContext {
  device?: DeviceInfoDto;
  /** The app the sign-in route implies, for builds that do not name one on the device. */
  app?: ClientApp | null;
  ipAddress?: string;
  userAgent?: string;
}

/** Published when an installation the account has never used before signs in. */
export interface NewDeviceSignedIn {
  userId: string;
  deviceId: string;
  platform: DevicePlatform;
  app: ClientApp | null;
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
    private readonly events: EventEmitter2,
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

  /** Whether a refresh must name its device, not merely match when it does. */
  private get requireDeviceOnRefresh(): boolean {
    return this.config.get<boolean>('auth.requireDeviceOnRefresh', false);
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
    // The app's own word first; failing that, what the sign-in route implies.
    const app = context.device?.app ?? context.app ?? null;
    const deviceId = context.device ? await this.upsertDevice(user.id, context.device, app) : null;

    const session = await this.prisma.userSession.create({
      data: {
        userId: user.id,
        deviceId,
        app,
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
        session: { select: { app: true, device: { select: { installationId: true } } } },
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

    await this.assertSameDevice(existing.session?.device?.installationId, context.device, existing.familyId);

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
      data: {
        lastSeenAt: new Date(),
        ipAddress: context.ipAddress ?? undefined,
        // A session opened by a build that did not say which app it was learns
        // it the first time an updated build refreshes it.
        ...(!existing.session.app && context.device?.app ? { app: context.device.app } : {}),
      },
    });

    return tokens;
  }

  /**
   * Keeps a refresh token on the device it was issued to.
   *
   * Rotation already catches a stolen token *after* it is used twice; this
   * refuses it the first time, on a device that is not the one that signed in.
   *
   * A mismatch is always refused and burns the family — a token being
   * presented from somewhere else is the definition of the leak the family
   * revocation exists for. A request that says nothing about its device is a
   * judgement call: older app builds do not send one, so refusing by default
   * would sign every one of their users out on the day this shipped. It is
   * allowed and logged, and `AUTH_REFRESH_REQUIRE_DEVICE=true` turns it into a
   * refusal once the apps in the field are known to send it.
   *
   * The two mobile apps are separate installations, so one person running both
   * the customer and driver app has two sessions with two device ids, and
   * neither can refresh the other.
   */
  private async assertSameDevice(
    sessionInstallationId: string | undefined,
    device: DeviceInfoDto | undefined,
    familyId: string,
  ): Promise<void> {
    if (!sessionInstallationId) return;

    if (!device?.installationId) {
      if (this.requireDeviceOnRefresh) {
        this.logger.warn(`Refresh without a device for family ${familyId}`);
        throw AppException.unauthorized(
          ResponseCode.REFRESH_TOKEN_INVALID,
          'This session is tied to a device. Sign in again.',
        );
      }
      return;
    }

    if (device.installationId !== sessionInstallationId) {
      await this.revokeFamily(familyId);
      this.logger.warn(`Refresh from a different device for family ${familyId}; family revoked`);
      throw AppException.unauthorized(
        ResponseCode.REFRESH_TOKEN_REUSED,
        'This session has been revoked for security reasons. Please sign in again.',
      );
    }
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

  /**
   * Revokes the session a refresh token belongs to — only when it belongs to
   * `userId`, so signing out cannot be used to end somebody else's session.
   */
  async revokeByRefreshToken(refreshToken: string, userId: string): Promise<void> {
    const tokenHash = CryptoUtil.sha256(refreshToken);
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      select: { sessionId: true, userId: true },
    });
    if (record?.userId === userId) await this.revokeSession(record.sessionId);
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

  private async upsertDevice(userId: string, device: DeviceInfoDto, app: ClientApp | null): Promise<string> {
    const where = { userId_installationId: { userId, installationId: device.installationId } };
    const known = await this.prisma.device.findUnique({ where, select: { id: true } });

    const record = await this.prisma.device.upsert({
      where,
      create: {
        userId,
        installationId: device.installationId,
        platform: device.platform,
        app,
        model: device.model,
        osVersion: device.osVersion,
        appVersion: device.appVersion,
        locale: device.locale,
      },
      update: {
        platform: device.platform,
        // Never cleared by a build that does not say: an installation does not
        // stop being the driver app because an older code path signed it in.
        ...(app ? { app } : {}),
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

    if (!known) {
      await this.announceNewDevice(userId, record.id, device.platform, app);
    }

    return record.id;
  }

  /**
   * Tells the account holder when an installation they have not used before
   * signs in.
   *
   * Not for the first one — that is them signing up. From the second on, a
   * sign-in they do not recognise is the earliest warning that someone else
   * has their password, and one password now opens a driver's wallet as well
   * as the customer app. Published rather than sent from here, so the auth
   * module does not reach into notifications.
   */
  private async announceNewDevice(
    userId: string,
    deviceId: string,
    platform: DevicePlatform,
    app: ClientApp | null,
  ): Promise<void> {
    const others = await this.prisma.device.count({ where: { userId, NOT: { id: deviceId } } });
    if (others === 0) return;

    this.events.emit(DomainEvent.NEW_DEVICE_SIGNED_IN, {
      userId,
      deviceId,
      platform,
      app,
    } satisfies NewDeviceSignedIn);
  }
}
