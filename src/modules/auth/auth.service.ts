import { Injectable, Logger } from '@nestjs/common';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import { PhoneUtil } from '../../common/utils/phone.util.js';
import { PrismaService } from '../../database/prisma.service.js';
import { UsersService } from '../users/users.service.js';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface.js';
import {
  ClientApp,
  type DriverApprovalStatus,
  OtpChannel,
  OtpPurpose,
  UserRole,
  UserStatus,
} from '../../generated/prisma/enums.js';
import type {
  ForgotPasswordDto,
  LoginDto,
  DeviceInfoDto,
  RegisterCustomerDto,
  ResetPasswordDto,
  SendOtpDto,
  SetPasswordDto,
  StepUpDto,
  VerifyForgotPasswordDto,
  VerifyOtpDto,
} from './dto/auth-request.dto.js';
import type {
  AuthSessionDto,
  AuthUserDto,
  OtpChallengeDto,
  OtpVerifiedDto,
  RegistrationStartedDto,
  StepUpTokenDto,
} from './dto/auth-response.dto.js';
import { OtpService } from './services/otp.service.js';
import { LoginAttemptsService } from './services/login-attempts.service.js';
import { PasswordService } from './services/password.service.js';
import { StepUpService } from './services/step-up.service.js';
import { TokenService } from './services/token.service.js';

export interface RequestMetadata {
  ipAddress?: string;
  userAgent?: string;
}

/**
 * The role every mobile account carries.
 *
 * One person has one account for both apps: they order deliveries as a
 * customer and, once approved, drive with the same credentials. `role` no
 * longer distinguishes the two — the profiles on the account do — so it exists
 * only to keep back-office accounts a genuinely separate login.
 */
const MOBILE_ROLE = UserRole.CUSTOMER;

/**
 * Accepts the role an older app still sends and maps it onto the single
 * mobile account. A build that posts `role: "DRIVER"` keeps working; it just
 * resolves to the same account its customer screens use.
 */
function mobileRoleOf(role?: UserRole): UserRole {
  return role === UserRole.ADMIN ? UserRole.ADMIN : MOBILE_ROLE;
}

/**
 * Which app an older build is, from the role it still names at sign-in.
 *
 * Builds from before the apps said which they were each sent their own role —
 * the customer app CUSTOMER, the driver app DRIVER — and that is the only word
 * they give. A build that names neither is left unknown, and treated as both.
 */
function appFromRole(role?: UserRole): ClientApp | null {
  if (role === UserRole.CUSTOMER) return ClientApp.CUSTOMER;
  if (role === UserRole.DRIVER) return ClientApp.DRIVER;
  return null;
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
    private readonly stepUps: StepUpService,
  ) {}

  // ── Registration ───────────────────────────────────────────────────────

  async register(
    dto: RegisterCustomerDto,
    enrolAsDriver: boolean,
    meta: RequestMetadata,
  ): Promise<RegistrationStartedDto> {
    const role = MOBILE_ROLE;
    const existing = await this.users.findByPhoneAndRole(dto.phone, role);

    if (existing && existing.status !== UserStatus.PENDING_VERIFICATION) {
      // From the driver app this is nearly always someone who already orders
      // with us. One account serves both apps, so the way in is to sign in and
      // apply — say so, rather than leave them trying another number.
      throw AppException.conflict(
        ResponseCode.ACCOUNT_ALREADY_EXISTS,
        enrolAsDriver
          ? 'You already have an account with this number. Sign in with the same password, then apply to drive.'
          : undefined,
      );
    }

    // Re-registering an unverified account simply refreshes it — the customer
    // never gets stuck because they closed the app before entering the code.
    const user = existing
      ? await this.refreshPendingRegistration(existing.id, dto, enrolAsDriver)
      : await this.createPendingUser(dto, enrolAsDriver);

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

  /**
   * Every mobile account can order from the moment it exists, so the customer
   * profile is unconditional. Signing up through the driver app additionally
   * enrols them, which saves that person applying immediately afterwards —
   * they still wait for approval like anyone else.
   */
  private async createPendingUser(dto: RegisterCustomerDto, enrolAsDriver: boolean) {
    return this.prisma.user.create({
      data: {
        phone: dto.phone,
        email: dto.email,
        role: MOBILE_ROLE,
        status: UserStatus.PENDING_VERIFICATION,
        customerProfile: { create: { fullName: dto.fullName } },
        ...(enrolAsDriver
          ? { driverProfile: { create: { fullName: dto.fullName, availability: { create: {} } } } }
          : {}),
      },
      select: { id: true },
    });
  }

  private async refreshPendingRegistration(userId: string, dto: RegisterCustomerDto, enrolAsDriver: boolean) {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        email: dto.email,
        customerProfile: {
          upsert: { create: { fullName: dto.fullName }, update: { fullName: dto.fullName } },
        },
        // Someone who abandoned a customer sign-up and came back through the
        // driver app should end up enrolled, not silently a customer again.
        ...(enrolAsDriver
          ? {
              driverProfile: {
                upsert: {
                  create: { fullName: dto.fullName, availability: { create: {} } },
                  update: { fullName: dto.fullName },
                },
              },
            }
          : {}),
      },
      select: { id: true },
    });
  }

  // ── OTP ────────────────────────────────────────────────────────────────

  async sendOtp(dto: SendOtpDto, meta: RequestMetadata): Promise<OtpChallengeDto> {
    const identifier = this.normaliseIdentifier(dto);

    const existing = await this.users.findByPhoneAndRole(identifier, mobileRoleOf(dto.role));

    if (dto.purpose === OtpPurpose.REGISTRATION && existing && existing.status !== UserStatus.PENDING_VERIFICATION) {
      throw AppException.conflict(ResponseCode.ACCOUNT_ALREADY_EXISTS);
    }

    // Without an account nothing could spend this code — set-password needs the
    // pending account that register creates, and a reset needs a real one — so
    // nothing is sent. Otherwise this endpoint would text any number on request.
    if (!existing) {
      return this.decoyChallenge(identifier);
    }

    const challenge = await this.otp.issue({
      identifier,
      channel: dto.channel,
      purpose: dto.purpose,
      role: mobileRoleOf(dto.role),
      ipAddress: meta.ipAddress,
    });

    return this.toChallengeDto(identifier, challenge);
  }

  async verifyOtp(dto: VerifyOtpDto): Promise<OtpVerifiedDto> {
    const identifier = this.normaliseIdentifier(dto);

    const result = await this.otp.verify(
      { identifier, purpose: dto.purpose, role: mobileRoleOf(dto.role) },
      dto.code,
    );

    return {
      verificationToken: result.token,
      expiresAt: result.expiresAt.toISOString(),
    };
  }

  // ── Password ───────────────────────────────────────────────────────────

  /** `app` is the one whose sign-up route this came through. */
  async setPassword(dto: SetPasswordDto, meta: RequestMetadata, app: ClientApp): Promise<AuthSessionDto> {
    const role = MOBILE_ROLE;

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
      { device: dto.device, app, ipAddress: meta.ipAddress, userAgent: meta.userAgent },
    );

    const refreshed = await this.users.findById(user.id);
    return { user: this.toAuthUserDto(refreshed!, dto.device?.app ?? app), tokens };
  }

  async forgotPassword(dto: ForgotPasswordDto, meta: RequestMetadata): Promise<OtpChallengeDto> {
    return this.sendOtp(
      {
        identifier: dto.phone,
        channel: OtpChannel.SMS,
        purpose: OtpPurpose.PASSWORD_RESET,
        role: mobileRoleOf(dto.role),
      },
      meta,
    );
  }

  async verifyForgotPassword(dto: VerifyForgotPasswordDto): Promise<OtpVerifiedDto> {
    return this.verifyOtp({
      identifier: dto.phone,
      channel: OtpChannel.SMS,
      purpose: OtpPurpose.PASSWORD_RESET,
      role: mobileRoleOf(dto.role),
      code: dto.code,
    });
  }

  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    await this.otp.consumeVerificationToken(
      { identifier: dto.phone, purpose: OtpPurpose.PASSWORD_RESET, role: mobileRoleOf(dto.role) },
      dto.verificationToken,
    );

    const user = await this.users.findByPhoneAndRole(dto.phone, mobileRoleOf(dto.role));
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
    // a mobile account and a back-office account on the same number are
    // separate logins, and locking an operator out because someone guessed at
    // the mobile password would be an attack in itself.
    const role = mobileRoleOf(dto.role);
    await this.loginAttempts.assertNotLocked(dto.phone, role);

    const user = await this.users.findByPhoneAndRole(dto.phone, role);

    if (!user) {
      // Equalise timing so a missing account is indistinguishable from a wrong password.
      await this.passwords.fakeVerify();
      // Counted too, so probing for numbers that exist looks exactly like
      // guessing a password.
      await this.loginAttempts.recordFailure(dto.phone, role);
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
      await this.loginAttempts.recordFailure(dto.phone, role);
      throw AppException.unauthorized(ResponseCode.INVALID_CREDENTIALS);
    }

    this.users.assertUsable(user.status);
    await this.loginAttempts.recordSuccess(dto.phone, role);

    if (this.passwords.needsRehash(user.passwordHash)) {
      const rehashed = await this.passwords.hash(dto.password);
      await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash: rehashed } });
    }

    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    const app = dto.device?.app ?? appFromRole(dto.role);
    const { tokens } = await this.tokens.createSession(
      { id: user.id, role: user.role },
      { device: dto.device, app, ipAddress: meta.ipAddress, userAgent: meta.userAgent },
    );

    return { user: this.toAuthUserDto(user, app), tokens };
  }

  async refresh(refreshToken: string, meta: RequestMetadata & { device?: DeviceInfoDto }) {
    return this.tokens.rotate(refreshToken, meta);
  }

  async logout(sessionId: string, options: { refreshToken?: string; allDevices?: boolean; userId: string }): Promise<void> {
    if (options.allDevices) {
      await this.tokens.revokeAllSessions(options.userId);
    } else if (options.refreshToken) {
      await this.tokens.revokeByRefreshToken(options.refreshToken, options.userId);
    } else {
      await this.tokens.revokeSession(sessionId);
    }

    await this.users.invalidateAuthContext(options.userId);
  }

  // ── Step-up ────────────────────────────────────────────────────────────

  /**
   * Confirms the password again before something that moves money.
   *
   * One password now opens the driver wallet as well as the customer app, so
   * a signed-in session alone must not be enough to redirect a payout.
   * Failures count towards the same lockout as sign-in: this is a password
   * check, and guessing here must cost exactly what it costs at the login
   * screen. A wrong password is 403, not 401 — the session is fine, and most
   * apps answer a 401 by signing the person out.
   */
  async stepUp(principal: AuthenticatedUser, dto: StepUpDto): Promise<StepUpTokenDto> {
    const user = await this.users.findById(principal.userId);
    if (!user?.passwordHash) {
      throw AppException.forbidden(ResponseCode.INVALID_CREDENTIALS);
    }

    await this.loginAttempts.assertNotLocked(user.phone, user.role);

    if (!(await this.passwords.verify(user.passwordHash, dto.password))) {
      await this.loginAttempts.recordFailure(user.phone, user.role);
      throw AppException.forbidden(ResponseCode.INVALID_CREDENTIALS, 'That password is not right.');
    }

    await this.loginAttempts.recordSuccess(user.phone, user.role);
    return this.stepUps.issue(principal.sessionId);
  }

  // ── Mapping helpers ────────────────────────────────────────────────────

  toAuthUserDto(
    user: {
      id: string;
      phone: string;
      email: string | null;
      role: UserRole;
      status: UserStatus;
      customerProfile: { id: string; fullName: string; avatarFileId: string | null; suspendedAt: Date | null } | null;
      driverProfile: {
        id: string;
        fullName: string;
        avatarFileId: string | null;
        approvalStatus: DriverApprovalStatus;
      } | null;
    },
    app?: ClientApp | null,
  ): AuthUserDto {
    // Each app shows its own name: the driver app the one the driver was
    // approved under, the customer app whatever the person chose. A build
    // that has not said which app it is gets the customer's, as before.
    const profile =
      app === ClientApp.DRIVER
        ? (user.driverProfile ?? user.customerProfile)
        : (user.customerProfile ?? user.driverProfile);

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
      customerSuspended: Boolean(user.customerProfile?.suspendedAt),
      driverApprovalStatus: user.driverProfile?.approvalStatus ?? null,
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
