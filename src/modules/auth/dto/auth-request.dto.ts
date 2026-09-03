import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { DevicePlatform, OtpChannel, OtpPurpose, UserRole } from '../../../generated/prisma/enums.js';
import { PhoneUtil } from '../../../common/utils/phone.util.js';

/** Normalises to E.164 at the edge so the database only ever sees one shape. */
const NormalisePhone = () => Transform(({ value }) => (typeof value === 'string' ? PhoneUtil.normalise(value) : value));

const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).{8,}$/;

export class DeviceInfoDto {
  @ApiProperty({ example: 'A1B2C3D4-E5F6-7890-ABCD-EF1234567890' })
  @IsString()
  @MaxLength(128)
  installationId: string;

  @ApiProperty({ enum: DevicePlatform })
  @IsEnum(DevicePlatform)
  platform: DevicePlatform;

  @ApiPropertyOptional({ example: 'iPhone15,3' })
  @IsString()
  @MaxLength(64)
  @IsOptional()
  model?: string;

  @ApiPropertyOptional({ example: '18.2' })
  @IsString()
  @MaxLength(32)
  @IsOptional()
  osVersion?: string;

  @ApiPropertyOptional({ example: '1.4.0' })
  @IsString()
  @MaxLength(32)
  @IsOptional()
  appVersion?: string;

  @ApiPropertyOptional({ example: 'km-KH' })
  @IsString()
  @MaxLength(16)
  @IsOptional()
  locale?: string;

  @ApiPropertyOptional({ description: 'FCM registration token for push notifications.' })
  @IsString()
  @MaxLength(512)
  @IsOptional()
  pushToken?: string;
}

export class RegisterCustomerDto {
  @ApiProperty({ example: '012345678', description: 'Cambodian phone number in any local format.' })
  @NormalisePhone()
  @Matches(/^\+\d{8,15}$/, { message: 'Phone number is invalid.' })
  phone: string;

  @ApiProperty({ example: 'Sok Dara' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  fullName: string;

  @ApiPropertyOptional({ example: 'dara@example.com' })
  @IsEmail({}, { message: 'Email address is invalid.' })
  @IsOptional()
  email?: string;
}

export class RegisterDriverDto extends RegisterCustomerDto {}

export class SendOtpDto {
  @ApiProperty({ example: '012345678', description: 'Phone number, or email when channel is EMAIL.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  identifier: string;

  @ApiProperty({ enum: OtpChannel, default: OtpChannel.SMS })
  @IsEnum(OtpChannel)
  channel: OtpChannel = OtpChannel.SMS;

  @ApiProperty({ enum: OtpPurpose })
  @IsEnum(OtpPurpose)
  purpose: OtpPurpose;

  @ApiProperty({ enum: UserRole, description: 'Which account the code is for — one phone may hold both.' })
  @IsEnum(UserRole)
  role: UserRole;
}

export class ResendOtpDto extends SendOtpDto {}

export class VerifyOtpDto extends SendOtpDto {
  @ApiProperty({ example: '482913' })
  @IsString()
  @Matches(/^\d{4,8}$/, { message: 'Verification code is invalid.' })
  code: string;
}

export class SetPasswordDto {
  @ApiProperty({ example: '012345678' })
  @NormalisePhone()
  @Matches(/^\+\d{8,15}$/, { message: 'Phone number is invalid.' })
  phone: string;

  @ApiProperty({ description: 'The token returned by POST /auth/otp/verify.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  verificationToken: string;

  @ApiProperty({ example: 'Passw0rd!', minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(PASSWORD_RULE, { message: 'Password must be at least 8 characters and contain a letter and a number.' })
  password: string;

  @ApiPropertyOptional({ type: DeviceInfoDto })
  @ValidateNested()
  @Type(() => DeviceInfoDto)
  @IsOptional()
  device?: DeviceInfoDto;
}

export class LoginDto {
  @ApiProperty({ example: '012345678' })
  @NormalisePhone()
  @Matches(/^\+\d{8,15}$/, { message: 'Phone number is invalid.' })
  phone: string;

  @ApiProperty({ example: 'Passw0rd!' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password: string;

  @ApiProperty({ enum: UserRole, description: 'The app signing in. Customer app sends CUSTOMER, driver app DRIVER.' })
  @IsEnum(UserRole)
  role: UserRole;

  @ApiPropertyOptional({ type: DeviceInfoDto })
  @ValidateNested()
  @Type(() => DeviceInfoDto)
  @IsOptional()
  device?: DeviceInfoDto;
}

export class RefreshTokenDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  refreshToken: string;
}

export class LogoutDto {
  @ApiPropertyOptional({ description: 'Revokes just this session. Omit to revoke the current session only.' })
  @IsString()
  @MaxLength(1024)
  @IsOptional()
  refreshToken?: string;

  @ApiPropertyOptional({ description: 'Revoke every session for this account.', default: false })
  @IsOptional()
  allDevices?: boolean;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: '012345678' })
  @NormalisePhone()
  @Matches(/^\+\d{8,15}$/, { message: 'Phone number is invalid.' })
  phone: string;

  @ApiProperty({ enum: UserRole })
  @IsEnum(UserRole)
  role: UserRole;
}

export class VerifyForgotPasswordDto extends ForgotPasswordDto {
  @ApiProperty({ example: '482913' })
  @IsString()
  @Matches(/^\d{4,8}$/, { message: 'Verification code is invalid.' })
  code: string;
}

export class ResetPasswordDto extends ForgotPasswordDto {
  @ApiProperty({ description: 'The token returned by POST /auth/forgot-password/verify.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  verificationToken: string;

  @ApiProperty({ example: 'Passw0rd!', minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(PASSWORD_RULE, { message: 'Password must be at least 8 characters and contain a letter and a number.' })
  newPassword: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  currentPassword: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(PASSWORD_RULE, { message: 'Password must be at least 8 characters and contain a letter and a number.' })
  newPassword: string;
}
