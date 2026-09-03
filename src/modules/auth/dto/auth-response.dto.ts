import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole, UserStatus } from '../../../generated/prisma/enums.js';

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

  @ApiProperty({ example: 'Sok Dara' })
  fullName: string;

  @ApiPropertyOptional({ nullable: true })
  avatarUrl: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Set for CUSTOMER accounts.' })
  customerId: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Set for DRIVER accounts.' })
  driverId: string | null;
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
