import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ApiErrorResponses, ApiSuccessResponse } from '../../common/decorators/api-docs.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { ResponseCode as ResponseCodeMeta } from '../../common/decorators/response-code.decorator.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface.js';
import { UserRole } from '../../generated/prisma/enums.js';
import { AuthService, type RequestMetadata } from './auth.service.js';
import {
  ForgotPasswordDto,
  LoginDto,
  LogoutDto,
  RefreshTokenDto,
  RegisterCustomerDto,
  RegisterDriverDto,
  ResendOtpDto,
  ResetPasswordDto,
  SendOtpDto,
  SetPasswordDto,
  VerifyForgotPasswordDto,
  VerifyOtpDto,
} from './dto/auth-request.dto.js';
import {
  AuthSessionDto,
  AuthTokensDto,
  OtpChallengeDto,
  OtpVerifiedDto,
  RegistrationStartedDto,
} from './dto/auth-response.dto.js';

@ApiTags('Authentication')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  private metadata(request: Request): RequestMetadata {
    return { ipAddress: request.ip, userAgent: request.headers['user-agent'] };
  }

  // ── Registration ───────────────────────────────────────────────────────

  @Public()
  @Post('customer/register')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ bucket: 'auth:register', limit: 10, windowSeconds: 3600 })
  @ResponseCodeMeta(ResponseCode.REGISTERED, 'Account created. Please verify the code we sent you.')
  @ApiOperation({
    summary: 'Start customer registration',
    description:
      'Creates a pending customer account and sends a verification code. The account only becomes usable after POST /auth/otp/verify followed by POST /auth/customer/set-password.',
  })
  @ApiSuccessResponse({ status: 201, code: ResponseCode.REGISTERED, type: RegistrationStartedDto })
  @ApiErrorResponses(
    { status: 400, code: ResponseCode.VALIDATION_ERROR },
    { status: 409, code: ResponseCode.ACCOUNT_ALREADY_EXISTS },
    { status: 429, code: ResponseCode.OTP_RATE_LIMITED },
  )
  registerCustomer(@Body() dto: RegisterCustomerDto, @Req() request: Request): Promise<RegistrationStartedDto> {
    return this.auth.register(dto, UserRole.CUSTOMER, this.metadata(request));
  }

  @Public()
  @Post('driver/register')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ bucket: 'auth:register', limit: 10, windowSeconds: 3600 })
  @ResponseCodeMeta(ResponseCode.REGISTERED, 'Driver account created. Please verify the code we sent you.')
  @ApiOperation({
    summary: 'Start driver registration',
    description:
      'Creates a pending driver account (approvalStatus PENDING_APPROVAL). Documents and a vehicle must be added before the driver can go online.',
  })
  @ApiSuccessResponse({ status: 201, code: ResponseCode.REGISTERED, type: RegistrationStartedDto })
  @ApiErrorResponses(
    { status: 409, code: ResponseCode.ACCOUNT_ALREADY_EXISTS },
    { status: 429, code: ResponseCode.OTP_RATE_LIMITED },
  )
  registerDriver(@Body() dto: RegisterDriverDto, @Req() request: Request): Promise<RegistrationStartedDto> {
    return this.auth.register(dto, UserRole.DRIVER, this.metadata(request));
  }

  // ── OTP ────────────────────────────────────────────────────────────────

  @Public()
  @Post('otp/send')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ bucket: 'auth:otp-send', limit: 20, windowSeconds: 3600 })
  @ResponseCodeMeta(ResponseCode.OTP_SENT)
  @ApiOperation({
    summary: 'Send a verification code',
    description:
      'Rate limited per IP and, inside the OTP service, per identifier. For PASSWORD_RESET the response is identical whether or not the account exists, so it cannot be used to discover registered numbers.',
  })
  @ApiSuccessResponse({ code: ResponseCode.OTP_SENT, type: OtpChallengeDto })
  @ApiErrorResponses(
    { status: 409, code: ResponseCode.ACCOUNT_ALREADY_EXISTS },
    { status: 429, code: ResponseCode.OTP_RESEND_TOO_SOON },
  )
  sendOtp(@Body() dto: SendOtpDto, @Req() request: Request): Promise<OtpChallengeDto> {
    return this.auth.sendOtp(dto, this.metadata(request));
  }

  @Public()
  @Post('otp/resend')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ bucket: 'auth:otp-send', limit: 20, windowSeconds: 3600 })
  @ResponseCodeMeta(ResponseCode.OTP_RESENT)
  @ApiOperation({
    summary: 'Resend the verification code',
    description:
      'Subject to a cooldown between sends and a daily cap per number, so a request that looks correct can still be refused with 429 — surface the wait rather than retrying automatically.',
  })
  @ApiSuccessResponse({ code: ResponseCode.OTP_RESENT, type: OtpChallengeDto })
  @ApiErrorResponses({ status: 429, code: ResponseCode.OTP_RESEND_TOO_SOON })
  resendOtp(@Body() dto: ResendOtpDto, @Req() request: Request): Promise<OtpChallengeDto> {
    return this.auth.sendOtp(dto, this.metadata(request));
  }

  @Public()
  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ bucket: 'auth:otp-verify', limit: 30, windowSeconds: 3600 })
  @ResponseCodeMeta(ResponseCode.OTP_VERIFIED)
  @ApiOperation({
    summary: 'Verify a code',
    description: 'Returns a single-use verification token, which the next step must present.',
  })
  @ApiSuccessResponse({ code: ResponseCode.OTP_VERIFIED, type: OtpVerifiedDto })
  @ApiErrorResponses(
    { status: 400, code: ResponseCode.OTP_INVALID },
    { status: 400, code: ResponseCode.OTP_EXPIRED },
    { status: 400, code: ResponseCode.OTP_MAX_ATTEMPTS_REACHED },
  )
  verifyOtp(@Body() dto: VerifyOtpDto): Promise<OtpVerifiedDto> {
    return this.auth.verifyOtp(dto);
  }

  // ── Password setup ─────────────────────────────────────────────────────

  @Public()
  @Post('customer/set-password')
  @HttpCode(HttpStatus.OK)
  @ResponseCodeMeta(ResponseCode.PASSWORD_SET)
  @ApiOperation({
    summary: 'Set the password for a verified customer account and sign in',
    description:
      'Takes the single-use verification token from OTP verify and returns a full session, so the app does not have to call login straight afterwards. The token is spent by this call.',
  })
  @ApiSuccessResponse({ code: ResponseCode.PASSWORD_SET, type: AuthSessionDto })
  @ApiErrorResponses(
    { status: 400, code: ResponseCode.VERIFICATION_TOKEN_INVALID },
    { status: 404, code: ResponseCode.ACCOUNT_NOT_FOUND },
  )
  setCustomerPassword(@Body() dto: SetPasswordDto, @Req() request: Request): Promise<AuthSessionDto> {
    return this.auth.setPassword(dto, UserRole.CUSTOMER, this.metadata(request));
  }

  @Public()
  @Post('driver/set-password')
  @HttpCode(HttpStatus.OK)
  @ResponseCodeMeta(ResponseCode.PASSWORD_SET)
  @ApiOperation({
    summary: 'Set the password for a verified driver account and sign in',
    description:
      'Takes the single-use verification token from OTP verify and returns a full session. A driver can sign in from here but cannot go online until their documents are approved.',
  })
  @ApiSuccessResponse({ code: ResponseCode.PASSWORD_SET, type: AuthSessionDto })
  @ApiErrorResponses(
    { status: 400, code: ResponseCode.VERIFICATION_TOKEN_INVALID },
    { status: 404, code: ResponseCode.ACCOUNT_NOT_FOUND },
  )
  setDriverPassword(@Body() dto: SetPasswordDto, @Req() request: Request): Promise<AuthSessionDto> {
    return this.auth.setPassword(dto, UserRole.DRIVER, this.metadata(request));
  }

  // ── Session ────────────────────────────────────────────────────────────

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ bucket: 'auth:login', limit: 15, windowSeconds: 300 })
  @ResponseCodeMeta(ResponseCode.LOGGED_IN)
  @ApiOperation({
    summary: 'Sign in',
    description:
      'One phone number may hold both a customer and a driver account, so the app must state which role it is signing in as.',
  })
  @ApiSuccessResponse({ code: ResponseCode.LOGGED_IN, type: AuthSessionDto })
  @ApiErrorResponses(
    { status: 401, code: ResponseCode.INVALID_CREDENTIALS },
    { status: 401, code: ResponseCode.PASSWORD_NOT_SET },
    { status: 403, code: ResponseCode.ACCOUNT_SUSPENDED },
    { status: 429, code: ResponseCode.RATE_LIMIT_EXCEEDED },
  )
  login(@Body() dto: LoginDto, @Req() request: Request): Promise<AuthSessionDto> {
    return this.auth.login(dto, this.metadata(request));
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ bucket: 'auth:refresh', limit: 60, windowSeconds: 300 })
  @ResponseCodeMeta(ResponseCode.TOKEN_REFRESHED)
  @ApiOperation({
    summary: 'Exchange a refresh token for a new pair',
    description:
      'Refresh tokens are single use. Presenting one twice revokes the whole token family, because that only happens if a token leaked.',
  })
  @ApiSuccessResponse({ code: ResponseCode.TOKEN_REFRESHED, type: AuthTokensDto })
  @ApiErrorResponses(
    { status: 401, code: ResponseCode.REFRESH_TOKEN_INVALID },
    { status: 401, code: ResponseCode.REFRESH_TOKEN_EXPIRED },
    { status: 401, code: ResponseCode.REFRESH_TOKEN_REUSED },
  )
  refresh(@Body() dto: RefreshTokenDto, @Req() request: Request): Promise<AuthTokensDto> {
    return this.auth.refresh(dto.refreshToken, { ...this.metadata(request), device: dto.device });
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ResponseCodeMeta(ResponseCode.LOGGED_OUT)
  @ApiOperation({
    summary: 'Sign out of this session, or every session',
    description:
      'Revokes the refresh token and its family. Access tokens already issued stay valid until they expire — they are short-lived by design — so treat sign-out as ending the ability to refresh, not as an instant kill switch.',
  })
  @ApiBody({ type: LogoutDto, required: false })
  @ApiSuccessResponse({ code: ResponseCode.LOGGED_OUT })
  @ApiErrorResponses({ status: 401, code: ResponseCode.UNAUTHORIZED })
  async logout(@CurrentUser() user: AuthenticatedUser, @Body() dto: LogoutDto): Promise<null> {
    await this.auth.logout(user.sessionId, {
      refreshToken: dto?.refreshToken,
      allDevices: dto?.allDevices,
      userId: user.userId,
    });
    return null;
  }

  // ── Password recovery ──────────────────────────────────────────────────

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ bucket: 'auth:forgot', limit: 10, windowSeconds: 3600 })
  @ResponseCodeMeta(ResponseCode.OTP_SENT, 'If the account exists, a reset code has been sent.')
  @ApiOperation({
    summary: 'Request a password reset code',
    description:
      'Answers the same way whether or not the number is registered, so this cannot be used to discover who has an account.',
  })
  @ApiSuccessResponse({ code: ResponseCode.OTP_SENT, type: OtpChallengeDto })
  @ApiErrorResponses({ status: 429, code: ResponseCode.OTP_RATE_LIMITED })
  forgotPassword(@Body() dto: ForgotPasswordDto, @Req() request: Request): Promise<OtpChallengeDto> {
    return this.auth.forgotPassword(dto, this.metadata(request));
  }

  @Public()
  @Post('forgot-password/verify')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ bucket: 'auth:otp-verify', limit: 30, windowSeconds: 3600 })
  @ResponseCodeMeta(ResponseCode.OTP_VERIFIED)
  @ApiOperation({
    summary: 'Verify a password reset code',
    description:
      'Exchanges the code for a single-use token to pass to reset-password. The code itself is never accepted by that endpoint.',
  })
  @ApiSuccessResponse({ code: ResponseCode.OTP_VERIFIED, type: OtpVerifiedDto })
  @ApiErrorResponses(
    { status: 400, code: ResponseCode.OTP_INVALID },
    { status: 400, code: ResponseCode.OTP_EXPIRED },
  )
  verifyForgotPassword(@Body() dto: VerifyForgotPasswordDto): Promise<OtpVerifiedDto> {
    return this.auth.verifyForgotPassword(dto);
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ResponseCodeMeta(ResponseCode.PASSWORD_RESET)
  @ApiOperation({
    summary: 'Set a new password',
    description: 'Revokes every existing session on success, so a stolen device cannot keep its tokens.',
  })
  @ApiSuccessResponse({ code: ResponseCode.PASSWORD_RESET })
  @ApiErrorResponses(
    { status: 400, code: ResponseCode.VERIFICATION_TOKEN_INVALID },
    { status: 404, code: ResponseCode.ACCOUNT_NOT_FOUND },
  )
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<null> {
    await this.auth.resetPassword(dto);
    return null;
  }
}
