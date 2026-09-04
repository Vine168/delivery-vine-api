import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsDefined,
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidateIf,
} from 'class-validator';
import { IsIntegerOrBoolean } from '../../../common/validators/integer-or-boolean.validator.js';
import { PageQueryDto } from '../../../common/dto/pagination.dto.js';
import { Currency, DiscountType, ZoneCoverageType } from '../../../generated/prisma/enums.js';

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;

// ── Vehicle types ────────────────────────────────────────────────────────

export class AdminCreateVehicleTypeDto {
  @ApiProperty({ example: 'MOTOR', description: 'Uppercase, stable — it appears in pricing and presence keys.' })
  @IsString()
  @Matches(CODE_PATTERN, { message: 'Code must be uppercase letters, digits, hyphen or underscore.' })
  code: string;

  @ApiProperty({ example: 'Motorbike' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name: string;

  @ApiPropertyOptional({ example: 'ម៉ូតូ' })
  @IsString()
  @MaxLength(80)
  @IsOptional()
  nameKm?: string;

  @ApiPropertyOptional({ example: 'Small parcels, up to 20 kg' })
  @IsString()
  @MaxLength(280)
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ example: 20 })
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  @IsOptional()
  maxWeightKg?: number;

  @ApiPropertyOptional({ example: 3 })
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  @IsOptional()
  maxPackages?: number;

  @ApiPropertyOptional({
    example: 'MOTOR',
    description: 'The profile passed to the map provider when routing this vehicle.',
  })
  @IsString()
  @MaxLength(32)
  @IsOptional()
  routingProfile?: string;

  @ApiPropertyOptional({ example: 1, description: 'Lower sorts first in the customer app.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  sortOrder?: number;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class AdminUpdateVehicleTypeDto extends PartialType(AdminCreateVehicleTypeDto) {}

// ── Zones ────────────────────────────────────────────────────────────────

export class AdminZoneQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Matches a code, name or city.' })
  @IsString()
  @MaxLength(120)
  @IsOptional()
  search?: string;

  @ApiPropertyOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class AdminCreateZoneDto {
  @ApiProperty({ example: 'PP-CENTRAL' })
  @IsString()
  @Matches(CODE_PATTERN, { message: 'Code must be uppercase letters, digits, hyphen or underscore.' })
  code: string;

  @ApiProperty({ example: 'Phnom Penh — Central' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(280)
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ example: 'Phnom Penh' })
  @IsString()
  @MaxLength(80)
  @IsOptional()
  city?: string;

  @ApiProperty({
    enum: ZoneCoverageType,
    description: 'RADIUS needs a centre and a radius; POLYGON needs a GeoJSON boundary.',
  })
  @IsEnum(ZoneCoverageType)
  coverageType: ZoneCoverageType;

  @ApiPropertyOptional({ example: 11.5564, description: 'Required when the coverage is a radius.' })
  @ValidateIf((dto: AdminCreateZoneDto) => dto.coverageType === ZoneCoverageType.RADIUS)
  @Type(() => Number)
  @IsLatitude()
  centerLatitude?: number;

  @ApiPropertyOptional({ example: 104.9282 })
  @ValidateIf((dto: AdminCreateZoneDto) => dto.coverageType === ZoneCoverageType.RADIUS)
  @Type(() => Number)
  @IsLongitude()
  centerLongitude?: number;

  @ApiPropertyOptional({ example: 8_000, description: 'Required when the coverage is a radius.' })
  @ValidateIf((dto: AdminCreateZoneDto) => dto.coverageType === ZoneCoverageType.RADIUS)
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(200_000)
  radiusMeters?: number;

  @ApiPropertyOptional({
    description: 'A GeoJSON Polygon. Required when the coverage is a polygon.',
    example: {
      type: 'Polygon',
      coordinates: [
        [
          [104.9, 11.5],
          [104.96, 11.5],
          [104.96, 11.6],
          [104.9, 11.6],
          [104.9, 11.5],
        ],
      ],
    },
  })
  @ValidateIf((dto: AdminCreateZoneDto) => dto.coverageType === ZoneCoverageType.POLYGON)
  @IsNotEmpty({ message: 'A polygon zone needs a boundary.' })
  boundary?: Record<string, unknown>;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class AdminUpdateZoneDto extends PartialType(AdminCreateZoneDto) {}

// ── Pricing rules ────────────────────────────────────────────────────────

export class AdminPricingRuleQueryDto extends PageQueryDto {
  @ApiPropertyOptional()
  @IsString()
  @MaxLength(32)
  @IsOptional()
  vehicleTypeId?: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(32)
  @IsOptional()
  zoneId?: string;

  @ApiPropertyOptional({ enum: Currency })
  @IsEnum(Currency)
  @IsOptional()
  currency?: Currency;

  @ApiPropertyOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class AdminCreatePricingRuleDto {
  @ApiProperty({ example: 'MOTOR standard (KHR)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  vehicleTypeId: string;

  @ApiPropertyOptional({ nullable: true, description: 'Leave empty for a rule that applies everywhere.' })
  @IsString()
  @IsOptional()
  zoneId?: string | null;

  @ApiProperty({ enum: Currency, description: 'Every amount below is in this currency’s minor units.' })
  @IsEnum(Currency)
  currency: Currency;

  @ApiProperty({ example: 4_000 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  baseFare: number;

  @ApiPropertyOptional({ example: 2_000, description: 'Distance already covered by the base fare.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  includedDistanceMeters?: number;

  @ApiPropertyOptional({ example: 1_000 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  pricePerKm?: number;

  @ApiPropertyOptional({ example: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  pricePerMinute?: number;

  @ApiPropertyOptional({ example: 4_000, description: 'The fare never falls below this.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  minimumFare?: number;

  @ApiPropertyOptional({ example: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  waitingFeePerMinute?: number;

  @ApiPropertyOptional({ example: 300 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  freeWaitingSeconds?: number;

  @ApiPropertyOptional({ example: 500 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  serviceFeeFlat?: number;

  @ApiPropertyOptional({ example: 0, description: 'Basis points: 250 is 2.5%.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  @IsOptional()
  serviceFeePercentBp?: number;

  @ApiPropertyOptional({ example: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  codFeeFlat?: number;

  @ApiPropertyOptional({ example: 100, description: 'Basis points.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  @IsOptional()
  codFeePercentBp?: number;

  @ApiPropertyOptional({ example: 2_000, description: 'The platform’s share, in basis points. 2000 is 20%.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  @IsOptional()
  commissionPercentBp?: number;

  @ApiPropertyOptional({ nullable: true, example: 1_000 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  minCommission?: number | null;

  @ApiPropertyOptional({ nullable: true, example: 20_000 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  maxCommission?: number | null;

  @ApiPropertyOptional({
    example: 10_000,
    description: 'Surge multiplier in basis points. 10000 is 1.00×, 12500 is 1.25×.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(10_000)
  @Max(50_000)
  @IsOptional()
  surgeMultiplierBp?: number;

  @ApiPropertyOptional({ example: 0, description: 'Higher priority wins when two rules both match.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  priority?: number;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ApiPropertyOptional({ example: '2026-10-01T00:00:00Z' })
  @IsDateString()
  @IsOptional()
  effectiveFrom?: string;

  @ApiPropertyOptional({ nullable: true, example: '2026-12-31T23:59:59Z' })
  @IsDateString()
  @IsOptional()
  effectiveTo?: string | null;
}

export class AdminUpdatePricingRuleDto extends PartialType(AdminCreatePricingRuleDto) {}

// ── Promo codes ──────────────────────────────────────────────────────────

export class AdminPromoCodeQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Matches a code or name.' })
  @IsString()
  @MaxLength(120)
  @IsOptional()
  search?: string;

  @ApiPropertyOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ApiPropertyOptional({ description: 'Only codes that are live right now — active and inside their window.' })
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  @IsOptional()
  runningNow?: boolean;
}

export class AdminCreatePromoCodeDto {
  @ApiProperty({ example: 'SAVE500', description: 'What the customer types. Uppercase and unique.' })
  @IsString()
  @Matches(CODE_PATTERN, { message: 'Code must be uppercase letters, digits, hyphen or underscore.' })
  code: string;

  @ApiProperty({ example: 'Save ៛500' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(280)
  @IsOptional()
  description?: string;

  @ApiProperty({ enum: Currency, description: 'A promo applies only to bookings priced in this currency.' })
  @IsEnum(Currency)
  currency: Currency;

  @ApiProperty({ enum: DiscountType })
  @IsEnum(DiscountType)
  discountType: DiscountType;

  @ApiProperty({
    example: 500,
    description: 'Minor units for FIXED_AMOUNT, basis points for PERCENTAGE — 1000 is 10%.',
  })
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  discountValue: number;

  @ApiPropertyOptional({ nullable: true, example: 3_000, description: 'Caps a percentage discount.' })
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  @IsOptional()
  maxDiscountAmount?: number | null;

  @ApiPropertyOptional({ nullable: true, example: 5_000 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  minOrderAmount?: number | null;

  @ApiProperty({ example: '2026-09-01T00:00:00Z' })
  @IsDateString()
  startsAt: string;

  @ApiProperty({ example: '2026-12-31T23:59:59Z' })
  @IsDateString()
  endsAt: string;

  @ApiPropertyOptional({ nullable: true, example: 1_000, description: 'Total redemptions allowed.' })
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  @IsOptional()
  usageLimit?: number | null;

  @ApiPropertyOptional({ nullable: true, example: 1 })
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  @IsOptional()
  perCustomerLimit?: number | null;

  @ApiPropertyOptional({
    type: [String],
    description: 'Restrict to these vehicle types. Empty means every vehicle type.',
  })
  @IsString({ each: true })
  @IsOptional()
  vehicleTypeIds?: string[];

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class AdminUpdatePromoCodeDto extends PartialType(AdminCreatePromoCodeDto) {}

// ── Settings ─────────────────────────────────────────────────────────────

export class AdminUpdateSettingDto {
  @ApiProperty({
    example: 8_000,
    description: 'A whole number or a boolean, according to the setting’s kind.',
    oneOf: [{ type: 'integer' }, { type: 'boolean' }],
  })
  // A union the pipe cannot express: the catalogue knows which kind each key
  // takes and rejects the wrong one with a message naming the setting, which
  // reads better than "value must be a number" on a boolean field.
  @IsDefined()
  @Validate(IsIntegerOrBoolean)
  value: number | boolean;
}
