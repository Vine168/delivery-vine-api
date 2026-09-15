import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DriverApprovalStatus, UserRole, UserStatus } from '../../../generated/prisma/enums.js';

export class AuthTokensDto {
  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' })
  accessToken: string;

  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' })
  refreshToken: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType: string;

  @ApiProperty({ example: 900, description: 'Access token lifetime in seconds.' })
  expiresIn: number;
}

export class AuthUserDto {
  @ApiProperty({ example: 'cm8x1a2b3c4d5e6f7g8h9i0j' })
  id: string;

  @ApiProperty({ example: '+85512345678' })
  phone: string;

  @ApiPropertyOptional({ nullable: true, example: 'dara@example.com' })
  email: string | null;

  @ApiProperty({ enum: UserRole })
  role: UserRole;

  @ApiProperty({ enum: UserStatus })
  status: UserStatus;

  @ApiProperty({
    example: 'Sok Dara',
    description:
      'The name for the app that signed in: in the driver app the one the driver was approved under, in the customer app the one the person chose.',
  })
  fullName: string;

  @ApiPropertyOptional({ nullable: true })
  avatarUrl: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Every mobile account has one: it can always order.' })
  customerId: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Set once the account has applied to drive, whatever the review decided. Null until then.',
  })
  driverId: string | null;

  @ApiProperty({
    example: false,
    description: 'True while an operator has stopped this account booking. The driver side is unaffected.',
  })
  customerSuspended: boolean;

  @ApiPropertyOptional({
    enum: DriverApprovalStatus,
    nullable: true,
    description:
      'Where the driver side stands, so the driver app can pick its first screen without another call. Null until the account applies to drive.',
  })
  driverApprovalStatus: DriverApprovalStatus | null;
}

export class StepUpTokenDto {
  @ApiProperty({ description: 'Send as the X-Step-Up-Token header.' })
  stepUpToken: string;

  @ApiProperty({ example: '2026-09-15T10:05:00.000Z' })
  expiresAt: string;
}

export class AuthSessionDto {
  @ApiProperty({ type: AuthUserDto })
  user: AuthUserDto;

  @ApiProperty({ type: AuthTokensDto })
  tokens: AuthTokensDto;
}

export class OtpChallengeDto {
  @ApiProperty({ example: '+85512345678', description: 'Masked when the caller is not yet authenticated.' })
  identifier: string;

  @ApiProperty({ example: '2026-09-03T08:05:00.000Z' })
  expiresAt: string;

  @ApiProperty({ example: 60, description: 'Seconds before another code may be requested.' })
  resendAfterSeconds: number;

  @ApiPropertyOptional({
    description: 'Only present when OTP_EXPOSE_IN_RESPONSE is enabled (non-production).',
    example: '482913',
  })
  debugCode?: string;
}

export class OtpVerifiedDto {
  @ApiProperty({ description: 'Single-use token proving the code was verified.' })
  verificationToken: string;

  @ApiProperty({ example: '2026-09-03T08:20:00.000Z' })
  expiresAt: string;
}

export class RegistrationStartedDto {
  @ApiProperty()
  userId: string;

  @ApiProperty({ enum: UserRole })
  role: UserRole;

  @ApiProperty({ type: OtpChallengeDto })
  otp: OtpChallengeDto;
}
