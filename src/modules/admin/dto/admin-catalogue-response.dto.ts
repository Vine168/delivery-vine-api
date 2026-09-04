import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Currency, DiscountType, ZoneCoverageType } from '../../../generated/prisma/enums.js';

export class AdminVehicleTypeDto {
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

  @ApiProperty({ example: 'MOTOR' })
  routingProfile: string;

  @ApiProperty({ example: 1 })
  sortOrder: number;

  @ApiProperty({ example: true })
  isActive: boolean;

  @ApiProperty({ example: 12, description: 'Drivers whose primary vehicle is of this type.' })
  driverCount: number;

  @ApiProperty({ example: 2, description: 'Pricing rules that price this vehicle type.' })
  pricingRuleCount: number;
}

export class AdminZoneDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'PP-CENTRAL' })
  code: string;

  @ApiProperty({ example: 'Phnom Penh — Central' })
  name: string;

  @ApiPropertyOptional({ nullable: true })
  description: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'Phnom Penh' })
  city: string | null;

  @ApiProperty({ enum: ZoneCoverageType })
  coverageType: ZoneCoverageType;

  @ApiPropertyOptional({ nullable: true, example: 11.5564 })
  centerLatitude: number | null;

  @ApiPropertyOptional({ nullable: true, example: 104.9282 })
  centerLongitude: number | null;

  @ApiPropertyOptional({ nullable: true, example: 8_000 })
  radiusMeters: number | null;

  @ApiPropertyOptional({ nullable: true, description: 'GeoJSON polygon, when the coverage is a polygon.' })
  boundary: Record<string, unknown> | null;

  @ApiProperty({ example: true })
  isActive: boolean;

  @ApiProperty({ example: 18, description: 'Drivers assigned to this zone.' })
  driverCount: number;

  @ApiProperty({ example: 1, description: 'Pricing rules scoped to this zone.' })
  pricingRuleCount: number;

  @ApiProperty()
  createdAt: string;
}

export class AdminPricingRuleDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'MOTOR standard (KHR)' })
  name: string;

  @ApiProperty()
  vehicleTypeId: string;

  @ApiProperty({ example: 'MOTOR' })
  vehicleTypeCode: string;

  @ApiPropertyOptional({ nullable: true })
  zoneId: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'PP-CENTRAL' })
  zoneCode: string | null;

  @ApiProperty({ enum: Currency })
  currency: Currency;

  @ApiProperty({ example: 4_000 })
  baseFare: number;

  @ApiProperty({ example: 2_000 })
  includedDistanceMeters: number;

  @ApiProperty({ example: 1_000 })
  pricePerKm: number;

  @ApiProperty({ example: 0 })
  pricePerMinute: number;

  @ApiProperty({ example: 4_000 })
  minimumFare: number;

  @ApiProperty({ example: 0 })
  waitingFeePerMinute: number;

  @ApiProperty({ example: 300 })
  freeWaitingSeconds: number;

  @ApiProperty({ example: 500 })
  serviceFeeFlat: number;

  @ApiProperty({ example: 0 })
  serviceFeePercentBp: number;

  @ApiProperty({ example: 0 })
  codFeeFlat: number;

  @ApiProperty({ example: 100 })
  codFeePercentBp: number;

  @ApiProperty({ example: 2_000 })
  commissionPercentBp: number;

  @ApiPropertyOptional({ nullable: true, example: 1_000 })
  minCommission: number | null;

  @ApiPropertyOptional({ nullable: true, example: 20_000 })
  maxCommission: number | null;

  @ApiProperty({ example: 10_000 })
  surgeMultiplierBp: number;

  @ApiProperty({ example: 0 })
  priority: number;

  @ApiProperty({ example: true })
  isActive: boolean;

  @ApiProperty()
  effectiveFrom: string;

  @ApiPropertyOptional({ nullable: true })
  effectiveTo: string | null;

  @ApiProperty({
    example: 3,
    description: 'How many times this rule has been edited. Past deliveries keep the version that priced them.',
  })
  version: number;

  @ApiProperty({
    example: 1_204,
    description: 'Deliveries priced by this rule. Editing it never changes what they were charged.',
  })
  deliveryCount: number;

  @ApiProperty()
  updatedAt: string;
}

export class AdminPromoCodeDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'SAVE500' })
  code: string;

  @ApiProperty({ example: 'Save ៛500' })
  name: string;

  @ApiPropertyOptional({ nullable: true })
  description: string | null;

  @ApiProperty({ enum: Currency })
  currency: Currency;

  @ApiProperty({ enum: DiscountType })
  discountType: DiscountType;

  @ApiProperty({ example: 500, description: 'Minor units for FIXED_AMOUNT, basis points for PERCENTAGE.' })
  discountValue: number;

  @ApiPropertyOptional({ nullable: true, example: 3_000 })
  maxDiscountAmount: number | null;

  @ApiPropertyOptional({ nullable: true, example: 5_000 })
  minOrderAmount: number | null;

  @ApiProperty()
  startsAt: string;

  @ApiProperty()
  endsAt: string;

  @ApiPropertyOptional({ nullable: true, example: 1_000 })
  usageLimit: number | null;

  @ApiProperty({ example: 412, description: 'Redemptions so far.' })
  usageCount: number;

  @ApiPropertyOptional({ nullable: true, example: 1 })
  perCustomerLimit: number | null;

  @ApiProperty({ example: true })
  isActive: boolean;

  @ApiProperty({
    example: true,
    description: 'Whether a customer could use it right now — active, inside its window, and not used up.',
  })
  isRunning: boolean;

  @ApiProperty({ type: [String], description: 'Vehicle type codes it is limited to. Empty means all.' })
  vehicleTypeCodes: string[];

  @ApiProperty({ example: 118_400, description: 'Total discount given away, in minor units.' })
  discountGiven: number;

  @ApiProperty()
  createdAt: string;
}

export class AdminSettingDto {
  @ApiProperty({ example: 'matching.radiusMeters' })
  key: string;

  @ApiProperty({ example: 'Matching' })
  category: string;

  @ApiProperty({ example: 'First search radius' })
  label: string;

  @ApiProperty()
  description: string;

  @ApiProperty({ enum: ['integer', 'boolean'] })
  kind: 'integer' | 'boolean';

  @ApiPropertyOptional({ example: 'metres' })
  unit?: string;

  @ApiPropertyOptional({ example: 500 })
  min?: number;

  @ApiPropertyOptional({ example: 30_000 })
  max?: number;

  @ApiProperty({ example: 8_000, description: 'What the platform is using right now.' })
  value: number | boolean;

  @ApiProperty({ example: 5_000, description: 'The deployment’s own value, used when nothing is stored.' })
  defaultValue: number | boolean;

  @ApiProperty({ example: true, description: 'Whether an operator has overridden the deployment default.' })
  isOverridden: boolean;

  @ApiPropertyOptional({ nullable: true })
  updatedAt: string | null;
}
