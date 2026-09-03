import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { PageQueryDto } from '../../../common/dto/pagination.dto.js';
import { PriceBreakdownDto } from '../../pricing/dto/price-breakdown.dto.js';
import {
  ActorType,
  CodPayer,
  Currency,
  DeliveryStatus,
  PackageSize,
  PaymentMethod,
  PaymentStatus,
} from '../../../generated/prisma/enums.js';

export class DeliveryStopViewDto {
  @ApiProperty()
  address: string;

  @ApiProperty({ example: 11.5564 })
  latitude: number;

  @ApiProperty({ example: 104.9282 })
  longitude: number;

  @ApiProperty()
  contactName: string;

  @ApiProperty({ example: '+85512345678' })
  contactPhone: string;

  @ApiPropertyOptional({ nullable: true })
  note: string | null;

  @ApiPropertyOptional({ nullable: true })
  placeId: string | null;
}

export class DeliveryPackageViewDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: PackageSize })
  size: PackageSize;

  @ApiProperty({ example: 1 })
  quantity: number;

  @ApiPropertyOptional({ nullable: true, example: 3.5 })
  weightKg: number | null;

  @ApiPropertyOptional({ nullable: true })
  category: string | null;

  @ApiPropertyOptional({ nullable: true })
  description: string | null;

  @ApiPropertyOptional({ nullable: true })
  remarks: string | null;

  @ApiPropertyOptional({ nullable: true, example: 100_000 })
  declaredValueAmount: number | null;

  @ApiPropertyOptional({ nullable: true, enum: Currency })
  declaredValueCurrency: Currency | null;

  @ApiPropertyOptional({ nullable: true, description: 'Presigned URL; expires.' })
  photoUrl: string | null;
}

export class DeliveryDriverViewDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'Chan Sopheak' })
  fullName: string;

  @ApiProperty({ example: '+85512345678' })
  phone: string;

  @ApiPropertyOptional({ nullable: true })
  avatarUrl: string | null;

  @ApiProperty({ example: 4.82 })
  ratingAverage: number;

  @ApiProperty({ example: 613 })
  completedDeliveries: number;

  @ApiPropertyOptional({ nullable: true, example: '1AB-2345' })
  plateNumber: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'Motorbike' })
  vehicleName: string | null;
}

export class DeliveryTimelineEntryDto {
  @ApiProperty({ enum: DeliveryStatus })
  status: DeliveryStatus;

  @ApiProperty({ enum: ActorType })
  actorType: ActorType;

  @ApiPropertyOptional({ nullable: true })
  reason: string | null;

  @ApiProperty()
  at: string;
}

export class DeliveryDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'ORD-20260903-00128' })
  bookingCode: string;

  @ApiProperty({ enum: DeliveryStatus })
  status: DeliveryStatus;

  @ApiProperty({ type: DeliveryStopViewDto })
  pickup: DeliveryStopViewDto;

  @ApiProperty({ type: DeliveryStopViewDto })
  dropoff: DeliveryStopViewDto;

  @ApiProperty({ example: 'MOTOR' })
  vehicleTypeCode: string;

  @ApiProperty({ example: 'Motorbike' })
  vehicleTypeName: string;

  @ApiProperty({ example: 3_420 })
  distanceMeters: number;

  @ApiProperty({ example: 780 })
  durationSeconds: number;

  @ApiPropertyOptional({ nullable: true, description: 'Encoded polyline for drawing the route.' })
  routePolyline: string | null;

  @ApiProperty({ type: PriceBreakdownDto })
  price: PriceBreakdownDto;

  @ApiProperty({ enum: PaymentMethod })
  paymentMethod: PaymentMethod;

  @ApiProperty({ enum: PaymentStatus })
  paymentStatus: PaymentStatus;

  @ApiProperty({ example: false })
  codEnabled: boolean;

  @ApiPropertyOptional({ nullable: true, example: 40_000 })
  codAmount: number | null;

  @ApiPropertyOptional({ nullable: true, enum: CodPayer })
  codPayer: CodPayer | null;

  @ApiProperty({ type: [DeliveryPackageViewDto] })
  packages: DeliveryPackageViewDto[];

  @ApiPropertyOptional({ nullable: true, type: DeliveryDriverViewDto, description: 'Present once a driver is assigned.' })
  driver: DeliveryDriverViewDto | null;

  @ApiPropertyOptional({ nullable: true })
  note: string | null;

  @ApiPropertyOptional({ nullable: true, enum: ActorType })
  cancelledByType: ActorType | null;

  @ApiPropertyOptional({ nullable: true })
  cancelReason: string | null;

  @ApiProperty({ example: true, description: 'Whether this customer can cancel it right now.' })
  canCancel: boolean;

  @ApiProperty({ example: false })
  canRate: boolean;

  @ApiProperty({ type: [DeliveryTimelineEntryDto] })
  timeline: DeliveryTimelineEntryDto[];

  @ApiProperty()
  createdAt: string;

  @ApiPropertyOptional({ nullable: true })
  confirmedAt: string | null;

  @ApiPropertyOptional({ nullable: true })
  assignedAt: string | null;

  @ApiPropertyOptional({ nullable: true })
  pickedUpAt: string | null;

  @ApiPropertyOptional({ nullable: true })
  deliveredAt: string | null;

  @ApiPropertyOptional({ nullable: true })
  cancelledAt: string | null;
}

export class DeliverySummaryDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'ORD-20260903-00128' })
  bookingCode: string;

  @ApiProperty({ enum: DeliveryStatus })
  status: DeliveryStatus;

  @ApiProperty({ example: 'St. 271, Boeng Keng Kang' })
  pickupAddress: string;

  @ApiProperty({ example: 'Aeon Mall 1' })
  dropoffAddress: string;

  @ApiProperty({ example: 'MOTOR' })
  vehicleTypeCode: string;

  @ApiProperty({ example: 5_800 })
  totalAmount: number;

  @ApiProperty({ enum: Currency })
  currency: Currency;

  @ApiProperty({ enum: PaymentMethod })
  paymentMethod: PaymentMethod;

  @ApiProperty({ enum: PaymentStatus })
  paymentStatus: PaymentStatus;

  @ApiProperty({ example: 3_420 })
  distanceMeters: number;

  @ApiPropertyOptional({ nullable: true, example: 'Chan Sopheak' })
  driverName: string | null;

  @ApiProperty()
  createdAt: string;

  @ApiPropertyOptional({ nullable: true })
  deliveredAt: string | null;
}

export class QuoteDto {
  @ApiProperty({ example: 3_420 })
  distanceMeters: number;

  @ApiProperty({ example: 780 })
  durationSeconds: number;

  @ApiPropertyOptional({ nullable: true })
  routePolyline: string | null;

  @ApiProperty({
    example: 'roktenh',
    description: '`roktenh` for a real route; `haversine` when the map provider was unreachable and the estimate is approximate.',
  })
  routeSource: string;

  @ApiProperty({ example: 'MOTOR' })
  vehicleTypeCode: string;

  @ApiProperty({ type: PriceBreakdownDto })
  price: PriceBreakdownDto;

  @ApiProperty({
    example: '2026-09-03T09:15:00.000Z',
    description: 'Quotes are indicative. The price is recalculated when the booking is created.',
  })
  expiresAt: string;
}

/** Filters for the customer's delivery history. */
export class ListDeliveriesQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: DeliveryStatus, isArray: true, description: 'Repeat the parameter to filter on several statuses.' })
  @Type(() => String)
  @Transform(({ value }) => (Array.isArray(value) ? value : value === undefined ? undefined : [value]))
  @IsEnum(DeliveryStatus, { each: true })
  @IsOptional()
  status?: DeliveryStatus[];

  @ApiPropertyOptional({ example: '2026-09-01' })
  @IsString()
  @IsOptional()
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-09-30' })
  @IsString()
  @IsOptional()
  dateTo?: string;

  @ApiPropertyOptional({ example: 'ORD-20260903', description: 'Matches a booking code or an address.' })
  @IsString()
  @IsOptional()
  search?: string;
}
