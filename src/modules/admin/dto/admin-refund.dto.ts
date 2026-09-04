import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsNotEmpty, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';
import { PageQueryDto } from '../../../common/dto/pagination.dto.js';
import {
  Currency,
  PaymentMethod,
  PaymentProvider,
  RefundStatus,
} from '../../../generated/prisma/enums.js';

export class AdminRefundQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: RefundStatus, isArray: true })
  @Transform(({ value }) => (Array.isArray(value) ? value : value === undefined ? undefined : [value]))
  @IsEnum(RefundStatus, { each: true })
  @IsOptional()
  status?: RefundStatus[];

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(32)
  @IsOptional()
  deliveryId?: string;
}

export class AdminRequestRefundDto {
  @ApiPropertyOptional({
    example: 15_800,
    description: 'Minor units. Omit to refund everything still outstanding on the payment.',
  })
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  @IsOptional()
  amount?: number;

  @ApiProperty({ example: 'Cancelled after pickup because the recipient could not be reached' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

export class AdminSettleRefundDto {
  @ApiProperty({
    example: 'ABA-RFND-4471',
    description:
      'The provider’s reference for the refund that actually happened. Required — a refund nobody can trace to a real transaction is indistinguishable from one that never happened.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  providerRef: string;
}

export class AdminRefundDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  paymentId: string;

  @ApiProperty()
  deliveryId: string;

  @ApiProperty({ example: 'ORD-20260903-00128' })
  bookingCode: string;

  @ApiProperty({ example: 'Sok Dara' })
  customerName: string;

  @ApiProperty({ example: 15_800, description: 'Being refunded, in minor units.' })
  amount: number;

  @ApiProperty({ example: 15_800, description: 'What the original payment was, for context.' })
  paymentAmount: number;

  @ApiProperty({ enum: Currency })
  currency: Currency;

  @ApiProperty({ enum: PaymentMethod })
  method: PaymentMethod;

  @ApiProperty({ enum: PaymentProvider })
  provider: PaymentProvider;

  @ApiProperty({ enum: RefundStatus })
  status: RefundStatus;

  @ApiProperty()
  reason: string;

  @ApiPropertyOptional({ nullable: true })
  providerRef: string | null;

  @ApiPropertyOptional({ nullable: true })
  failureReason: string | null;

  @ApiProperty({ example: 'Sok Dara' })
  requestedByName: string;

  @ApiPropertyOptional({ nullable: true })
  settledByName: string | null;

  @ApiProperty()
  requestedAt: string;

  @ApiPropertyOptional({ nullable: true })
  settledAt: string | null;
}
