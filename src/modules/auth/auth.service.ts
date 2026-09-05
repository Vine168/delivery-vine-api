import { Injectable, Logger } from '@nestjs/common';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import { PhoneUtil } from '../../common/utils/phone.util.js';
import { PrismaService } from '../../database/prisma.service.js';
import { UsersService } from '../users/users.service.js';
import { OtpChannel, OtpPurpose, UserRole, UserStatus } from '../../generated/prisma/enums.js';
import type {
  ForgotPasswordDto,
  LoginDto,
  RegisterCustomerDto,
  ResetPasswordDto,
  SendOtpDto,
  SetPasswordDto,
  VerifyForgotPasswordDto,
  VerifyOtpDto,
} from './dto/auth-request.dto.js';
import type {
  AuthSessionDto,
  AuthUserDto,
  OtpChallengeDto,
  OtpVerifiedDto,
  RegistrationStartedDto,
} from './dto/auth-response.dto.js';
import { OtpService } from './services/otp.service.js';
import { LoginAttemptsService } from './services/login-attempts.service.js';
import { PasswordService } from './services/password.service.js';
import { TokenService } from './services/token.service.js';

export interface RequestMetadata {
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly tokens: TokenService,
    private readonly otp: OtpService,
    private readonly passwords: PasswordService,
    private readonly loginAttempts: LoginAttemptsService,
  ) {}

  // ── Registration ───────────────────────────────────────────────────────

  async register(dto: RegisterCustomerDto, role: UserRole, meta: RequestMetadata): Promise<RegistrationStartedDto> {
    const existing = await this.users.findByPhoneAndRole(dto.phone, role);

    if (existing && existing.status !== UserStatus.PENDING_VERIFICATION) {
      throw AppException.conflict(ResponseCode.ACCOUNT_ALREADY_EXISTS);
    }

    // Re-registering an unverified account simply refreshes it — the customer
    // never gets stuck because they closed the app before entering the code.
    const user = existing
      ? await this.refreshPendingRegistration(existing.id, dto, role)
      : await this.createPendingUser(dto, role);

    const challenge = await this.otp.issue({
      identifier: dto.phone,
      channel: OtpChannel.SMS,
      purpose: OtpPurpose.REGISTRATION,
      role,
      ipAddress: meta.ipAddress,
    });

    return {
      userId: user.id,
      role,
      otp: this.toChallengeDto(dto.phone, challenge),
    };
  }

  private async createPendingUser(dto: RegisterCustomerDto, role: UserRole) {
    return this.prisma.user.create({
      data: {
        phone: dto.phone,
        email: dto.email,
        role,
        status: UserStatus.PENDING_VERIFICATION,
        ...(role === UserRole.CUSTOMER
          ? { customerProfile: { create: { fullName: dto.fullName } } }
          : { driverProfile: { create: { fullName: dto.fullName, availability: { create: {} } } } }),
      },
      select: { id: true },
    });
  }

  private async refreshPendingRegistration(userId: string, dto: RegisterCustomerDto, role: UserRole) {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        email: dto.email,
        ...(role === UserRole.CUSTOMER
          ? { customerProfile: { update: { fullName: dto.fullName } } }
          : { driverProfile: { update: { fullName: dto.fullName } } }),
      },
      select: { id: true },
    });
  }

  // ── OTP ────────────────────────────────────────────────────────────────

  async sendOtp(dto: SendOtpDto, meta: RequestMetadata): Promise<OtpChallengeDto> {
    const identifier = this.normaliseIdentifier(dto);

    if (dto.purpose === OtpPurpose.REGISTRATION) {
      const existing = await this.users.findByPhoneAndRole(identifier, dto.role);
      if (existing && existing.status !== UserStatus.PENDING_VERIFICATION) {
        throw AppException.conflict(ResponseCode.ACCOUNT_ALREADY_EXISTS);
      }
    }

    if (dto.purpose === OtpPurpose.PASSWORD_RESET || dto.purpose === OtpPurpose.LOGIN) {
      const existing = await this.users.findByPhoneAndRole(identifier, dto.role);
      if (!existing) {
        // Do not confirm whether the account exists; return a plausible challenge.
        return this.decoyChallenge(identifier);
      }
    }

    const challenge = await this.otp.issue({
      identifier,
      channel: dto.channel,
      purpose: dto.purpose,
      role: dto.role,
      ipAddress: meta.ipAddress,
    });

    return this.toChallengeDto(identifier, challenge);
  }

  async verifyOtp(dto: VerifyOtpDto): Promise<OtpVerifiedDto> {
    const identifier = this.normaliseIdentifier(dto);

    const result = await this.otp.verify(
      { identifier, purpose: dto.purpose, role: dto.role },
      dto.code,
    );

    return {
      verificationToken: result.token,
      expiresAt: result.expiresAt.toISOString(),
    };
  }

  // ── Password ───────────────────────────────────────────────────────────

  async setPassword(dto: SetPasswordDto, role: UserRole, meta: RequestMetadata): Promise<AuthSessionDto> {
    await this.otp.consumeVerificationToken(
      { identifier: dto.phone, purpose: OtpPurpose.REGISTRATION, role },
      dto.verificationToken,
    );

    const user = await this.users.findByPhoneAndRole(dto.phone, role);
    if (!user) {
      throw AppException.notFound(ResponseCode.ACCOUNT_NOT_FOUND);
    }

    const passwordHash = await this.passwords.hash(dto.password);

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        status: UserStatus.ACTIVE,
        phoneVerifiedAt: user.phoneVerifiedAt ?? new Date(),
        lastLoginAt: new Date(),
      },
    });

    await this.users.invalidateAuthContext(user.id);

    const { tokens } = await this.tokens.createSession(
      { id: user.id, role: user.role },
      { device: dto.device, ipAddress: meta.ipAddress, userAgent: meta.userAgent },
    );

    const refreshed = await this.users.findById(user.id);
    return { user: this.toAuthUserDto(refreshed!), tokens };
  }

  async forgotPassword(dto: ForgotPasswordDto, meta: RequestMetadata): Promise<OtpChallengeDto> {
    return this.sendOtp(
      {
        identifier: dto.phone,
        channel: OtpChannel.SMS,
        purpose: OtpPurpose.PASSWORD_RESET,
        role: dto.role,
      },
      meta,
    );
  }

  async verifyForgotPassword(dto: VerifyForgotPasswordDto): Promise<OtpVerifiedDto> {
    return this.verifyOtp({
      identifier: dto.phone,
      channel: OtpChannel.SMS,
      purpose: OtpPurpose.PASSWORD_RESET,
      role: dto.role,
      code: dto.code,
    });
  }

  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    await this.otp.consumeVerificationToken(
      { identifier: dto.phone, purpose: OtpPurpose.PASSWORD_RESET, role: dto.role },
      dto.verificationToken,
    );

    const user = await this.users.findByPhoneAndRole(dto.phone, dto.role);
    if (!user) {
      throw AppException.notFound(ResponseCode.ACCOUNT_NOT_FOUND);
    }

    const passwordHash = await this.passwords.hash(dto.newPassword);

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        status: user.status === UserStatus.PENDING_VERIFICATION ? UserStatus.ACTIVE : user.status,
        phoneVerifiedAt: user.phoneVerifiedAt ?? new Date(),
      },
    });

    // A password reset invalidates every existing session on every device.
    await this.tokens.revokeAllSessions(user.id);
    await this.users.invalidateAuthContext(user.id);
  }

  // ── Session ────────────────────────────────────────────────────────────

  async login(dto: LoginDto, meta: RequestMetadata): Promise<AuthSessionDto> {
    // Before the password is touched, so a locked account costs an attacker a
    // request and teaches them nothing. Scoped to this phone *and* this role:
    // one number holds a separate customer, driver and back-office account,
    // and locking a driver out of earning because someone guessed at their
    // customer password would be an attack in itself.
    await this.loginAttempts.assertNotLocked(dto.phone, dto.role);

    const user = await this.users.findByPhoneAndRole(dto.phone, dto.role);

    if (!user) {
      // Equalise timing so a missing account is indistinguishable from a wrong password.
      await this.passwords.fakeVerify();
      // Counted too, so probing for numbers that exist looks exactly like
      // guessing a password.
      await this.loginAttempts.recordFailure(dto.phone, dto.role);
      throw AppException.unauthorized(ResponseCode.INVALID_CREDENTIALS);
    }

    if (!user.passwordHash) {
      throw AppException.unauthorized(
        ResponseCode.PASSWORD_NOT_SET,
        'Please finish setting up your account before signing in.',
      );
    }

    const valid = await this.passwords.verify(user.passwordHash, dto.password);
    if (!valid) {
      await this.loginAttempts.recordFailure(dto.phone, dto.role);
      throw AppException.unauthorized(ResponseCode.INVALID_CREDENTIALS);
    }

    this.users.assertUsable(user.status);
    await this.loginAttempts.recordSuccess(dto.phone, dto.role);

    if (this.passwords.needsRehash(user.passwordHash)) {
      const rehashed = await this.passwords.hash(dto.password);
      await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash: rehashed } });
    }

    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    const { tokens } = await this.tokens.createSession(
      { id: user.id, role: user.role },
      { device: dto.device, ipAddress: meta.ipAddress, userAgent: meta.userAgent },
    );

    return { user: this.toAuthUserDto(user), tokens };
  }

  async refresh(refreshToken: string, meta: RequestMetadata) {
    return this.tokens.rotate(refreshToken, meta);
  }

  async logout(sessionId: string, options: { refreshToken?: string; allDevices?: boolean; userId: string }): Promise<void> {
    if (options.allDevices) {
      await this.tokens.revokeAllSessions(options.userId);
    } else if (options.refreshToken) {
      await this.tokens.revokeByRefreshToken(options.refreshToken);
    } else {
      await this.tokens.revokeSession(sessionId);
    }

    await this.users.invalidateAuthContext(options.userId);
  }

  // ── Mapping helpers ────────────────────────────────────────────────────

  toAuthUserDto(user: {
    id: string;
    phone: string;
    email: string | null;
    role: UserRole;
    status: UserStatus;
    customerProfile: { id: string; fullName: string; avatarFileId: string | null } | null;
    driverProfile: { id: string; fullName: string; avatarFileId: string | null } | null;
  }): AuthUserDto {
    const profile = user.customerProfile ?? user.driverProfile;

    return {
      id: user.id,
      phone: user.phone,
      email: user.email,
      role: user.role,
      status: user.status,
      fullName: profile?.fullName ?? '',
      avatarUrl: null,
      customerId: user.customerProfile?.id ?? null,
      driverId: user.driverProfile?.id ?? null,
    };
  }

  private toChallengeDto(identifier: string, challenge: { expiresAt: Date; resendAfterSeconds: number; debugCode?: string }): OtpChallengeDto {
    return {
      identifier,
      expiresAt: challenge.expiresAt.toISOString(),
      resendAfterSeconds: challenge.resendAfterSeconds,
      ...(challenge.debugCode ? { debugCode: challenge.debugCode } : {}),
    };
  }

  /** Same shape and timing as a real challenge, but nothing was sent. */
  private decoyChallenge(identifier: string): OtpChallengeDto {
    this.logger.debug(`OTP requested for unknown account ${identifier}`);
    return {
      identifier,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      resendAfterSeconds: 60,
    };
  }

  /** Phone identifiers are normalised to E.164 so the OTP key always matches. */
  private normaliseIdentifier(dto: { identifier: string; channel: OtpChannel }): string {
    return dto.channel === OtpChannel.EMAIL
      ? dto.identifier.trim().toLowerCase()
      : PhoneUtil.normalise(dto.identifier);
  }
}
