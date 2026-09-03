import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Length, Min } from 'class-validator';
import { Currency, DiscountType } from '../../../generated/prisma/enums.js';

export class ValidatePromoDto {
  @ApiProperty({ example: 'SAVE500' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  @Length(2, 32)
  code: string;

  @ApiProperty({ example: 6_300, description: 'Order subtotal in minor units, from the quote.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  subtotal: number;

  @ApiProperty({ enum: Currency, default: Currency.KHR })
  @IsEnum(Currency)
  currency: Currency = Currency.KHR;

  @ApiPropertyOptional({ description: 'Vehicle type being booked — some promos are restricted.' })
  @IsString()
  @IsOptional()
  vehicleTypeId?: string;
}

export class PromoValidationDto {
  @ApiProperty({ example: 'SAVE500' })
  code: string;

  @ApiProperty({ example: 'Save ៛500' })
  name: string;

  @ApiPropertyOptional({ nullable: true })
  description: string | null;

  @ApiProperty({ enum: DiscountType })
  discountType: DiscountType;

  @ApiProperty({ example: 500, description: 'Discount applied to this order, in minor units.' })
  discountAmount: number;

  @ApiProperty({ enum: Currency })
  currency: Currency;

  @ApiProperty({ example: 5_800, description: 'What the customer would pay with this promo applied.' })
  totalAfterDiscount: number;

  @ApiProperty({ example: '2027-01-01T00:00:00.000Z' })
  endsAt: string;

  @ApiPropertyOptional({ nullable: true, example: 2, description: 'Uses left for this customer, when limited.' })
  remainingUses: number | null;
}
