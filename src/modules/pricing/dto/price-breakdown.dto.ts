import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Currency } from '../../../generated/prisma/enums.js';

export class PriceLineDto {
  @ApiProperty({ example: 'DISTANCE_FARE' })
  code: string;

  @ApiProperty({ example: 'Distance (3.4 km)' })
  label: string;

  @ApiProperty({ example: 1_400, description: 'Integer minor units. Negative for a discount.' })
  amount: number;
}

export class PriceBreakdownDto {
  @ApiProperty({ enum: Currency })
  currency: Currency;

  @ApiProperty({ example: 4_000 })
  baseFare: number;

  @ApiProperty({ example: 1_400 })
  distanceFare: number;

  @ApiProperty({ example: 0 })
  timeFare: number;

  @ApiProperty({ example: 0, description: 'Charged during the delivery, not at quote time.' })
  waitingFee: number;

  @ApiProperty({ example: 0 })
  surgeAmount: number;

  @ApiProperty({ example: 500 })
  serviceFee: number;

  @ApiProperty({ example: 400, description: 'Charged only when cash on delivery is collected.' })
  codFee: number;

  @ApiProperty({ example: 5_400, description: 'The ride itself — what the driver’s share is calculated from.' })
  fareSubtotal: number;

  @ApiProperty({ example: 6_300, description: 'Fare plus platform fees, before any discount.' })
  subtotal: number;

  @ApiProperty({ example: 500 })
  discountAmount: number;

  @ApiProperty({ example: 5_800, description: 'What the customer pays.' })
  totalAmount: number;

  @ApiProperty({ example: 2_000, description: 'Platform commission rate in basis points (2000 = 20%).' })
  commissionPercentBp: number;

  @ApiProperty({ example: 1_080 })
  commissionAmount: number;

  @ApiProperty({ example: 4_320, description: 'Unaffected by promo discounts — the platform absorbs those.' })
  driverEarningAmount: number;

  @ApiProperty({ example: false, description: 'True when the minimum fare replaced the calculated fare.' })
  minimumFareApplied: boolean;

  @ApiPropertyOptional({ nullable: true })
  promoCode: string | null;

  @ApiProperty({ type: [PriceLineDto], description: 'Ready to render as a receipt.' })
  lines: PriceLineDto[];
}
