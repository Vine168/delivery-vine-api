import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { LIMITS } from '../../../common/constants/app.constants.js';
import { PhoneUtil } from '../../../common/utils/phone.util.js';
import { CodPayer, Currency, PackageSize, PaymentMethod } from '../../../generated/prisma/enums.js';

const NormalisePhone = () => Transform(({ value }) => (typeof value === 'string' ? PhoneUtil.normalise(value) : value));

export class DeliveryStopDto {
  @ApiProperty({ example: 'St. 271, Boeng Keng Kang, Phnom Penh' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(400)
  address: string;

  @ApiProperty({ example: 11.5564 })
  @Type(() => Number)
  @IsNumber()
  @IsLatitude({ message: 'Latitude must be between -90 and 90.' })
  latitude: number;

  @ApiProperty({ example: 104.9282 })
  @Type(() => Number)
  @IsNumber()
  @IsLongitude({ message: 'Longitude must be between -180 and 180.' })
  longitude: number;

  @ApiPropertyOptional({ example: 'W:687168292', description: 'From the location search, if the pin came from one.' })
  @IsString()
  @MaxLength(120)
  @IsOptional()
  placeId?: string;

  @ApiProperty({ example: 'Sok Dara' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  contactName: string;

  @ApiProperty({ example: '012345678' })
  @NormalisePhone()
  @Matches(/^\+\d{8,15}$/, { message: 'Contact phone number is invalid.' })
  contactPhone: string;

  @ApiPropertyOptional({ example: 'Blue gate, ring the bell' })
  @IsString()
  @MaxLength(500)
  @IsOptional()
  note?: string;
}

export class DeclaredValueDto {
  @ApiProperty({ example: 100_000, description: 'Integer minor units — 100000 is ៛100,000.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  amount: number;

  @ApiProperty({ enum: Currency })
  @IsEnum(Currency)
  currency: Currency;
}

export class DeliveryPackageDto {
  @ApiProperty({ enum: PackageSize })
  @IsEnum(PackageSize)
  size: PackageSize;

  @ApiPropertyOptional({ example: 1, minimum: 1, maximum: 50, default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  @IsOptional()
  quantity = 1;

  @ApiPropertyOptional({ example: 3.5, description: 'Kilograms.' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1_000)
  @IsOptional()
  weightKg?: number;

  @ApiPropertyOptional({ example: 'DRINKS' })
  @IsString()
  @MaxLength(60)
  @IsOptional()
  category?: string;

  @ApiPropertyOptional({ example: 'Two crates of bottled water' })
  @IsString()
  @MaxLength(500)
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ example: 'Keep upright' })
  @IsString()
  @MaxLength(500)
  @IsOptional()
  remarks?: string;

  @ApiPropertyOptional({ type: DeclaredValueDto, description: 'What the contents are worth, for the driver’s awareness.' })
  @ValidateNested()
  @Type(() => DeclaredValueDto)
  @IsOptional()
  declaredValue?: DeclaredValueDto;

  @ApiPropertyOptional({ description: 'File id from POST /mobile/uploads with purpose PACKAGE_PHOTO.' })
  @IsString()
  @MaxLength(32)
  @IsOptional()
  photoFileId?: string;
}

export class CodDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  enabled: boolean;

  @ApiPropertyOptional({ example: 40_000, description: 'Amount the driver collects, in minor units.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  amount?: number;

  @ApiPropertyOptional({ enum: CodPayer, default: CodPayer.RECIPIENT, description: 'Who hands over the cash.' })
  @IsEnum(CodPayer)
  @IsOptional()
  payer?: CodPayer;
}

export class QuoteDeliveryDto {
  @ApiProperty({ type: DeliveryStopDto })
  @ValidateNested()
  @Type(() => DeliveryStopDto)
  pickup: DeliveryStopDto;

  @ApiProperty({ type: DeliveryStopDto })
  @ValidateNested()
  @Type(() => DeliveryStopDto)
  dropoff: DeliveryStopDto;

  @ApiProperty({ description: 'From GET /mobile/vehicle-types.' })
  @IsString()
  @MaxLength(32)
  vehicleTypeId: string;

  @ApiPropertyOptional({ enum: Currency, default: Currency.KHR })
  @IsEnum(Currency)
  @IsOptional()
  currency: Currency = Currency.KHR;

  @ApiPropertyOptional({ type: [DeliveryPackageDto] })
  @IsArray()
  @ArrayMaxSize(LIMITS.MAX_PACKAGES_PER_DELIVERY)
  @ValidateNested({ each: true })
  @Type(() => DeliveryPackageDto)
  @IsOptional()
  packages?: DeliveryPackageDto[];

  @ApiPropertyOptional({ example: 'SAVE500' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  @MaxLength(32)
  @IsOptional()
  promoCode?: string;

  @ApiPropertyOptional({ type: CodDto })
  @ValidateNested()
  @Type(() => CodDto)
  @IsOptional()
  cod?: CodDto;
}

/**
 * Declared before CreateDeliveryDto on purpose: `emitDecoratorMetadata`
 * evaluates the referenced class when the decorated class is defined, and
 * under ESM a class declared later is still in its temporal dead zone.
 */
export class RecipientDto {
  @ApiProperty({ example: 'Chan Sopheak' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiProperty({ example: '012345678' })
  @NormalisePhone()
  @Matches(/^\+\d{8,15}$/, { message: 'Recipient phone number is invalid.' })
  phone: string;

  @ApiPropertyOptional({ example: '012999888' })
  @NormalisePhone()
  @Matches(/^\+\d{8,15}$/, { message: 'Alternate phone number is invalid.' })
  @IsOptional()
  alternatePhone?: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(500)
  @IsOptional()
  note?: string;
}

export class CreateDeliveryDto extends QuoteDeliveryDto {
  @ApiProperty({ type: [DeliveryPackageDto], minItems: 1 })
  @IsArray()
  @ArrayMinSize(1, { message: 'At least one package is required.' })
  @ArrayMaxSize(LIMITS.MAX_PACKAGES_PER_DELIVERY)
  @ValidateNested({ each: true })
  @Type(() => DeliveryPackageDto)
  declare packages: DeliveryPackageDto[];

  @ApiProperty({ enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  paymentMethod: PaymentMethod;

  @ApiPropertyOptional({ example: 'Please call when you arrive' })
  @IsString()
  @MaxLength(500)
  @IsOptional()
  note?: string;

  @ApiPropertyOptional({ description: 'Recipient details, when they differ from the drop-off contact.' })
  @ValidateNested()
  @Type(() => RecipientDto)
  @IsOptional()
  recipient?: RecipientDto;
}

export class CancelDeliveryDto {
  @ApiPropertyOptional({ example: 'Changed my mind' })
  @IsString()
  @MaxLength(500)
  @IsOptional()
  reason?: string;
}
