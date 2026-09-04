import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { PageQueryDto } from '../../../common/dto/pagination.dto.js';
import {
  ActorType,
  CodPayer,
  Currency,
  DeliveryStatus,
  PaymentMethod,
  PaymentStatus,
} from '../../../generated/prisma/enums.js';

export class AdminDeliveryQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: DeliveryStatus,
    isArray: true,
    description: 'Repeat the parameter to include several statuses.',
  })
  @Transform(({ value }) => (Array.isArray(value) ? value : value === undefined ? undefined : [value]))
  @IsEnum(DeliveryStatus, { each: true })
  @IsOptional()
  status?: DeliveryStatus[];

  @ApiPropertyOptional({ enum: PaymentStatus })
  @IsEnum(PaymentStatus)
  @IsOptional()
  paymentStatus?: PaymentStatus;

  @ApiPropertyOptional({ enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  @IsOptional()
  paymentMethod?: PaymentMethod;

  @ApiPropertyOptional({ description: 'Only deliveries handled by this driver.' })
  @IsString()
  @MaxLength(32)
  @IsOptional()
  driverId?: string;

  @ApiPropertyOptional({ description: 'Only deliveries booked by this customer.' })
  @IsString()
  @MaxLength(32)
  @IsOptional()
  customerId?: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(32)
  @IsOptional()
  vehicleTypeId?: string;

  @ApiPropertyOptional({
    description: 'Matches a booking code, an address, or a customer or driver phone number.',
    example: 'ORD-20260903',
  })
  @IsString()
  @MaxLength(120)
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({ example: '2026-09-01' })
  @IsString()
  @IsOptional()
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-09-30' })
  @IsString()
  @IsOptional()
  dateTo?: string;

  @ApiPropertyOptional({
    description: 'Only deliveries that have been waiting for a driver longer than this many minutes.',
    example: 10,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  stalledForMinutes?: number;
}

export class AdminCancelDeliveryDto {
  @ApiProperty({ example: 'Customer called support to cancel' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

export class AdminReassignDeliveryDto {
  @ApiProperty({ example: 'Driver unreachable for 15 minutes' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

export class AdminPartyDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'Sok Dara' })
  fullName: string;

  @ApiProperty({ example: '+85512345678' })
  phone: string;

  @ApiPropertyOptional({ nullable: true })
  avatarUrl: string | null;
}

export class AdminDeliveryRowDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'ORD-20260903-00128' })
  bookingCode: string;

  @ApiProperty({ enum: DeliveryStatus })
  status: DeliveryStatus;

  @ApiProperty({ example: 'Independence Monument, Phnom Penh' })
  pickupAddress: string;

  @ApiProperty({ example: 'Chak Angrae, Phnom Penh' })
  dropoffAddress: string;

  @ApiProperty({ example: 'MOTOR' })
  vehicleTypeCode: string;

  @ApiProperty({ example: 12_825 })
  distanceMeters: number;

  @ApiProperty({ example: 15_800 })
  totalAmount: number;

  @ApiProperty({ example: 2_965, description: 'What the platform kept. Operators see this; customers do not.' })
  commissionAmount: number;

  @ApiProperty({ example: 11_860 })
  driverEarningAmount: number;

  @ApiProperty({ enum: Currency })
  currency: Currency;

  @ApiProperty({ enum: PaymentMethod })
  paymentMethod: PaymentMethod;

  @ApiProperty({ enum: PaymentStatus })
  paymentStatus: PaymentStatus;

  @ApiPropertyOptional({ nullable: true, type: AdminPartyDto })
  customer: AdminPartyDto | null;

  @ApiPropertyOptional({ nullable: true, type: AdminPartyDto })
  driver: AdminPartyDto | null;

  @ApiProperty({
    example: 4,
    description: 'Minutes this delivery has been waiting for a driver. Zero once assigned.',
  })
  waitingMinutes: number;

  @ApiProperty()
  createdAt: string;

  @ApiPropertyOptional({ nullable: true })
  deliveredAt: string | null;
}

export class AdminDeliveryTimelineEntryDto {
  @ApiProperty({ enum: DeliveryStatus, nullable: true })
  fromStatus: DeliveryStatus | null;

  @ApiProperty({ enum: DeliveryStatus })
  toStatus: DeliveryStatus;

  @ApiProperty({ enum: ActorType })
  actorType: ActorType;

  @ApiPropertyOptional({ nullable: true, description: 'Who did it, when a person did.' })
  actorName: string | null;

  @ApiPropertyOptional({ nullable: true })
  reason: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Where the driver was, when the step recorded it.' })
  metadata: Record<string, unknown> | null;

  @ApiProperty()
  at: string;
}

export class AdminDeliveryOfferDto {
  @ApiProperty()
  driverId: string;

  @ApiProperty({ example: 'Chan Sopheak' })
  driverName: string;

  @ApiProperty({ example: 'OFFERED' })
  status: string;

  @ApiProperty({ example: 1 })
  round: number;

  @ApiPropertyOptional({ nullable: true, example: 1_337 })
  distanceToPickupMeters: number | null;

  @ApiPropertyOptional({ nullable: true })
  declineReason: string | null;

  @ApiProperty()
  offeredAt: string;

  @ApiPropertyOptional({ nullable: true })
  respondedAt: string | null;
}

export class AdminDeliveryDetailDto extends AdminDeliveryRowDto {
  @ApiProperty({ example: 11.5564 })
  pickupLatitude: number;

  @ApiProperty({ example: 104.9282 })
  pickupLongitude: number;

  @ApiProperty({ example: 11.5 })
  dropoffLatitude: number;

  @ApiProperty({ example: 104.87 })
  dropoffLongitude: number;

  @ApiProperty({ example: 'Sok Dara' })
  pickupContactName: string;

  @ApiProperty({ example: '+85512345678' })
  pickupContactPhone: string;

  @ApiProperty({ example: 'Chan Vuthy' })
  dropoffContactName: string;

  @ApiProperty({ example: '+85512999888' })
  dropoffContactPhone: string;

  @ApiPropertyOptional({ nullable: true })
  pickupNote: string | null;

  @ApiPropertyOptional({ nullable: true })
  dropoffNote: string | null;

  @ApiProperty({ example: 1_800 })
  durationSeconds: number;

  @ApiPropertyOptional({ nullable: true })
  routePolyline: string | null;

  @ApiProperty({
    description: 'The full price breakdown exactly as it was calculated, including the platform split.',
  })
  price: Record<string, unknown>;

  @ApiProperty({ example: false })
  codEnabled: boolean;

  @ApiPropertyOptional({ nullable: true })
  codAmount: number | null;

  @ApiPropertyOptional({ nullable: true, enum: CodPayer })
  codPayer: CodPayer | null;

  @ApiPropertyOptional({ nullable: true })
  codCollectedAt: string | null;

  @ApiProperty({ type: [Object] })
  packages: Record<string, unknown>[];

  @ApiPropertyOptional({ nullable: true, type: Object })
  proofOfDelivery: Record<string, unknown> | null;

  @ApiPropertyOptional({ nullable: true, type: Object })
  rating: Record<string, unknown> | null;

  @ApiPropertyOptional({ nullable: true, enum: ActorType })
  cancelledByType: ActorType | null;

  @ApiPropertyOptional({ nullable: true })
  cancelReason: string | null;

  @ApiProperty({ type: [AdminDeliveryTimelineEntryDto] })
  timeline: AdminDeliveryTimelineEntryDto[];

  @ApiProperty({
    type: [AdminDeliveryOfferDto],
    description: 'Every driver this delivery was offered to, and what they did — the dispatch audit trail.',
  })
  offers: AdminDeliveryOfferDto[];
}

export class AdminLiveDeliveryDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'ORD-20260903-00128' })
  bookingCode: string;

  @ApiProperty({ enum: DeliveryStatus })
  status: DeliveryStatus;

  @ApiProperty({ example: 11.5564 })
  pickupLatitude: number;

  @ApiProperty({ example: 104.9282 })
  pickupLongitude: number;

  @ApiProperty({ example: 11.5 })
  dropoffLatitude: number;

  @ApiProperty({ example: 104.87 })
  dropoffLongitude: number;

  @ApiPropertyOptional({ nullable: true, example: 'Chan Sopheak' })
  driverName: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'The driver’s last known position, from the live stream. Null before assignment.',
  })
  driverLatitude: number | null;

  @ApiPropertyOptional({ nullable: true })
  driverLongitude: number | null;

  @ApiProperty({ example: 4 })
  waitingMinutes: number;
}
