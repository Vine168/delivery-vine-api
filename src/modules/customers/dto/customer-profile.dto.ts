import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsDateString, IsEmail, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { UserStatus } from '../../../generated/prisma/enums.js';

export class UpdateCustomerProfileDto {
  @ApiPropertyOptional({ example: 'Sok Dara' })
  @IsString()
  @Length(1, 120)
  @IsOptional()
  fullName?: string;

  @ApiPropertyOptional({ example: 'dara@example.com', nullable: true })
  @Transform(({ value }) => (value === null || value === '' ? null : String(value).trim().toLowerCase()))
  @IsEmail({}, { message: 'Email address is invalid.' })
  @IsOptional()
  email?: string | null;

  @ApiPropertyOptional({ example: '1996-04-12' })
  @IsDateString({}, { message: 'Date of birth must be a valid date.' })
  @IsOptional()
  dateOfBirth?: string;
}

export class UpdateAvatarDto {
  @ApiProperty({ description: 'File id from POST /mobile/uploads with purpose CUSTOMER_AVATAR.' })
  @IsString()
  @MaxLength(32)
  fileId: string;
}

export class CustomerStatsDto {
  @ApiProperty({ example: 42 })
  totalDeliveries: number;

  @ApiProperty({ example: 38 })
  completedDeliveries: number;

  @ApiProperty({ example: 2 })
  activeDeliveries: number;

  @ApiProperty({ example: 5 })
  savedAddresses: number;
}

export class CustomerProfileDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  userId: string;

  @ApiProperty({ example: 'Sok Dara' })
  fullName: string;

  @ApiProperty({ example: '+85512345678' })
  phone: string;

  @ApiPropertyOptional({ nullable: true })
  email: string | null;

  @ApiPropertyOptional({ nullable: true })
  avatarUrl: string | null;

  @ApiPropertyOptional({ nullable: true, example: '1996-04-12' })
  dateOfBirth: string | null;

  @ApiProperty({ enum: UserStatus })
  status: UserStatus;

  @ApiProperty({ example: true })
  phoneVerified: boolean;

  @ApiProperty({ type: CustomerStatsDto })
  stats: CustomerStatsDto;

  @ApiProperty({ example: '2026-09-03T09:00:00.000Z' })
  createdAt: string;
}
