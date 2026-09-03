import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { PageQueryDto } from '../../../common/dto/pagination.dto.js';
import { Currency, EarningStatus } from '../../../generated/prisma/enums.js';

export enum EarningsPeriod {
  TODAY = 'today',
  WEEK = 'week',
  MONTH = 'month',
}

export class EarningsSummaryQueryDto {
  @ApiPropertyOptional({ enum: EarningsPeriod, default: EarningsPeriod.TODAY })
  @IsEnum(EarningsPeriod)
  @IsOptional()
  period: EarningsPeriod = EarningsPeriod.TODAY;

  @ApiPropertyOptional({ enum: Currency, default: Currency.KHR })
  @IsEnum(Currency)
  @IsOptional()
  currency: Currency = Currency.KHR;
}

export class EarningsHistoryQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: Currency, default: Currency.KHR })
  @IsEnum(Currency)
  @IsOptional()
  currency: Currency = Currency.KHR;

  @ApiPropertyOptional({ enum: EarningStatus })
  @IsEnum(EarningStatus)
  @IsOptional()
  status?: EarningStatus;
}

export class EarningsSummaryDto {
  @ApiProperty({ enum: EarningsPeriod })
  period: EarningsPeriod;

  @ApiProperty({ example: '2026-09-03T00:00:00.000Z' })
  from: string;

  @ApiProperty({ example: '2026-09-03T23:59:59.999Z' })
  to: string;

  @ApiProperty({ enum: Currency })
  currency: Currency;

  @ApiProperty({ example: 7, description: 'Deliveries completed in this period.' })
  deliveryCount: number;

  @ApiProperty({ example: 110_600, description: 'What the customers paid, in minor units.' })
  grossAmount: number;

  @ApiProperty({ example: 20_755, description: 'Platform commission taken from those deliveries.' })
  commissionAmount: number;

  @ApiProperty({ example: 89_845, description: 'What the driver earned.' })
  netAmount: number;

  @ApiProperty({ example: 12_835, description: 'Average net per delivery.' })
  averagePerDelivery: number;
}

export class EarningDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  deliveryId: string;

  @ApiProperty({ example: 'ORD-20260903-00128' })
  bookingCode: string;

  @ApiProperty({ enum: Currency })
  currency: Currency;

  @ApiProperty({ example: 15_800, description: 'What the customer paid.' })
  deliveryAmount: number;

  @ApiProperty({ example: 2_000, description: 'Commission rate in basis points.' })
  commissionPercentBp: number;

  @ApiProperty({ example: 2_965 })
  commissionAmount: number;

  @ApiProperty({ example: 0 })
  tipAmount: number;

  @ApiProperty({ example: 0 })
  bonusAmount: number;

  @ApiProperty({ example: 11_860, description: 'Credited to the wallet.' })
  netAmount: number;

  @ApiProperty({ enum: EarningStatus })
  status: EarningStatus;

  @ApiPropertyOptional({ nullable: true, description: 'The ledger entry this earning created.' })
  walletTransactionId: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'Independence Monument' })
  pickupAddress: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'Chak Angrae' })
  dropoffAddress: string | null;

  @ApiPropertyOptional({ nullable: true, example: 12_825 })
  distanceMeters: number | null;

  @ApiProperty()
  earnedAt: string;
}
