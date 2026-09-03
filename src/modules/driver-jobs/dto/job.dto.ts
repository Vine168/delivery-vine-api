import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Currency, DeliveryStatus, PackageSize, PaymentMethod } from '../../../generated/prisma/enums.js';

export class DeclineJobDto {
  @ApiPropertyOptional({ example: 'Too far from me' })
  @IsString()
  @MaxLength(200)
  @IsOptional()
  reason?: string;
}

export class JobStopDto {
  @ApiProperty({ example: 'St. 271, Boeng Keng Kang, Phnom Penh' })
  address: string;

  @ApiProperty({ example: 11.5564 })
  latitude: number;

  @ApiProperty({ example: 104.9282 })
  longitude: number;

  @ApiPropertyOptional({ nullable: true })
  note: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Contact name. Withheld until the job is accepted.',
  })
  contactName: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: '+85512***678',
    description: 'Masked before acceptance, full afterwards.',
  })
  contactPhone: string | null;
}

export class JobPackageSummaryDto {
  @ApiProperty({ enum: PackageSize })
  size: PackageSize;

  @ApiProperty({ example: 2 })
  quantity: number;

  @ApiPropertyOptional({ nullable: true, example: 3.5 })
  weightKg: number | null;

  @ApiPropertyOptional({ nullable: true })
  category: string | null;
}

export class JobOfferDto {
  @ApiProperty({ description: 'The delivery id — use it for accept, decline and the execution endpoints.' })
  deliveryId: string;

  @ApiProperty({ example: 'ORD-20260903-00128' })
  bookingCode: string;

  @ApiProperty({ enum: DeliveryStatus })
  status: DeliveryStatus;

  @ApiProperty({ type: JobStopDto })
  pickup: JobStopDto;

  @ApiProperty({ type: JobStopDto })
  dropoff: JobStopDto;

  @ApiProperty({ example: 1_240, description: 'Road metres from the driver to the pickup.' })
  distanceToPickupMeters: number;

  @ApiProperty({ example: 11_500, description: 'Metres from pickup to drop-off.' })
  deliveryDistanceMeters: number;

  @ApiProperty({ example: 1_800, description: 'Estimated seconds for the delivery leg.' })
  estimatedDurationSeconds: number;

  @ApiProperty({ example: 'MOTOR' })
  vehicleTypeCode: string;

  @ApiProperty({ type: [JobPackageSummaryDto] })
  packages: JobPackageSummaryDto[];

  @ApiProperty({ example: 9_600, description: 'What the driver earns, in minor units.' })
  estimatedEarningAmount: number;

  @ApiProperty({ enum: Currency })
  currency: Currency;

  @ApiProperty({ enum: PaymentMethod })
  paymentMethod: PaymentMethod;

  @ApiProperty({ example: false })
  codEnabled: boolean;

  @ApiPropertyOptional({ nullable: true, example: 40_000, description: 'Cash the driver must collect.' })
  codAmount: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Customer’s first name only, until the job is accepted.',
  })
  customerName: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'When this offer lapses. Null once accepted.' })
  expiresAt: string | null;

  @ApiProperty({ example: false, description: 'True once this driver has accepted it.' })
  accepted: boolean;
}
