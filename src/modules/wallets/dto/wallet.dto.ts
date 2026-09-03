import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CursorQueryDto } from '../../../common/dto/pagination.dto.js';
import { IsEnum, IsOptional } from 'class-validator';
import {
  Currency,
  LedgerDirection,
  WalletTransactionStatus,
  WalletTransactionType,
} from '../../../generated/prisma/enums.js';

export class WalletDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: Currency })
  currency: Currency;

  @ApiProperty({ example: 148_000, description: 'Everything in the wallet, in minor units.' })
  balance: number;

  @ApiProperty({ example: 40_000, description: 'Committed to a pending withdrawal.' })
  reservedBalance: number;

  @ApiProperty({ example: 108_000, description: 'Balance minus reserved — what can be withdrawn now.' })
  availableBalance: number;

  @ApiProperty()
  updatedAt: string;
}

export class WalletTransactionDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: WalletTransactionType })
  type: WalletTransactionType;

  @ApiProperty({ enum: LedgerDirection })
  direction: LedgerDirection;

  @ApiProperty({ enum: WalletTransactionStatus })
  status: WalletTransactionStatus;

  @ApiProperty({ example: 11_860 })
  amount: number;

  @ApiProperty({ enum: Currency })
  currency: Currency;

  @ApiProperty({ example: 136_140 })
  balanceBefore: number;

  @ApiProperty({ example: 148_000 })
  balanceAfter: number;

  @ApiProperty({ example: 'delivery', description: 'What this entry refers to.' })
  referenceType: string;

  @ApiPropertyOptional({ nullable: true })
  referenceId: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'Delivery ORD-20260903-00128' })
  description: string | null;

  @ApiProperty()
  createdAt: string;
}

export class WalletTransactionQueryDto extends CursorQueryDto {
  @ApiPropertyOptional({ enum: WalletTransactionType })
  @IsEnum(WalletTransactionType)
  @IsOptional()
  type?: WalletTransactionType;

  @ApiPropertyOptional({ enum: Currency, default: Currency.KHR })
  @IsEnum(Currency)
  @IsOptional()
  currency: Currency = Currency.KHR;
}
