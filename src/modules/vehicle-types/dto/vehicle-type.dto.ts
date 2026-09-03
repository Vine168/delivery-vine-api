import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Currency } from '../../../generated/prisma/enums.js';

export class MoneyDto {
  @ApiProperty({ example: 4000, description: 'Integer amount in the currency minor unit.' })
  amount: number;

  @ApiProperty({ enum: Currency, example: Currency.KHR })
  currency: Currency;
}

export class VehicleTypeDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'MOTOR' })
  code: string;

  @ApiProperty({ example: 'Motorbike' })
  name: string;

  @ApiPropertyOptional({ nullable: true, example: 'ម៉ូតូ' })
  nameKm: string | null;

  @ApiPropertyOptional({ nullable: true })
  description: string | null;

  @ApiPropertyOptional({ nullable: true })
  iconUrl: string | null;

  @ApiPropertyOptional({ nullable: true, example: 20 })
  maxWeightKg: number | null;

  @ApiPropertyOptional({ nullable: true, example: 3 })
  maxPackages: number | null;

  @ApiPropertyOptional({
    nullable: true,
    type: MoneyDto,
    description: 'Base fare from the active pricing rule — what the fare starts at, not the final price.',
  })
  startingFare: MoneyDto | null;

  @ApiPropertyOptional({ nullable: true, type: MoneyDto, description: 'Price per kilometre beyond the included distance.' })
  pricePerKm: MoneyDto | null;
}
