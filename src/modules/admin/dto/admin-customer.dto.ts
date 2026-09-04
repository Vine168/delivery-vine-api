import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsDateString, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { PageQueryDto } from '../../../common/dto/pagination.dto.js';
import { Currency, UserStatus } from '../../../generated/prisma/enums.js';

export class AdminCustomerQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: UserStatus, isArray: true })
  @Transform(({ value }) => (Array.isArray(value) ? value : value === undefined ? undefined : [value]))
  @IsEnum(UserStatus, { each: true })
  @IsOptional()
  status?: UserStatus[];

  @ApiPropertyOptional({ description: 'Matches a name or phone number.', example: '012345' })
  @IsString()
  @MaxLength(120)
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({ example: '2026-09-01', description: 'Signed up on or after this date.' })
  @IsDateString()
  @IsOptional()
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-09-30', description: 'Signed up on or before this date.' })
  @IsDateString()
  @IsOptional()
  dateTo?: string;
}

export class AdminCustomerSpendDto {
  @ApiProperty({ enum: Currency })
  currency: Currency;

  @ApiProperty({ example: 158_000, description: 'Minor units, across delivered bookings only.' })
  totalSpent: number;

  @ApiProperty({ example: 10 })
  deliveredCount: number;
}

export class AdminCustomerRowDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  userId: string;

  @ApiProperty({ example: 'Sok Dara' })
  fullName: string;

  @ApiProperty({ example: '+85512345678' })
  phone: string;

  @ApiPropertyOptional({ nullable: true })
  avatarUrl: string | null;

  @ApiProperty({ enum: UserStatus })
  status: UserStatus;

  @ApiProperty({ example: 24, description: 'Bookings made, drafts excluded.' })
  deliveryCount: number;

  @ApiPropertyOptional({ nullable: true, description: 'When they last booked.' })
  lastOrderedAt: string | null;

  @ApiProperty()
  joinedAt: string;
}

export class AdminCustomerAddressDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'HOME' })
  label: string;

  @ApiProperty({ example: 'Street 271, Toul Kork' })
  address: string;

  @ApiProperty({ example: 11.5564 })
  latitude: number;

  @ApiProperty({ example: 104.9282 })
  longitude: number;

  @ApiProperty({ example: true })
  isDefault: boolean;
}

export class AdminCustomerDetailDto extends AdminCustomerRowDto {
  @ApiPropertyOptional({ nullable: true })
  email: string | null;

  @ApiPropertyOptional({ nullable: true })
  suspendedReason: string | null;

  @ApiPropertyOptional({ nullable: true })
  lastLoginAt: string | null;

  @ApiProperty({ example: 21 })
  deliveredCount: number;

  @ApiProperty({ example: 2 })
  cancelledCount: number;

  @ApiProperty({ example: 1, description: 'Bookings in motion right now.' })
  activeDeliveries: number;

  @ApiProperty({
    type: [AdminCustomerSpendDto],
    description: 'One entry per currency. Never summed together.',
  })
  spend: AdminCustomerSpendDto[];

  @ApiProperty({ type: [AdminCustomerAddressDto] })
  addresses: AdminCustomerAddressDto[];

  @ApiProperty({ example: 3 })
  favoriteDrivers: number;
}
