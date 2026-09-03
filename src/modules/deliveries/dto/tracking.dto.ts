import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DeliveryStatus } from '../../../generated/prisma/enums.js';
import { DeliveryDriverViewDto, DeliveryStopViewDto, DeliveryTimelineEntryDto } from './delivery-response.dto.js';
import { ProofOfDeliveryViewDto } from './execution.dto.js';

export class DriverPositionDto {
  @ApiProperty({ example: 11.5575 })
  latitude: number;

  @ApiProperty({ example: 104.9295 })
  longitude: number;

  @ApiPropertyOptional({ nullable: true, example: 180 })
  heading: number | null;

  @ApiPropertyOptional({ nullable: true, example: 8.3, description: 'Metres per second.' })
  speed: number | null;

  @ApiProperty({ example: '2026-09-03T09:12:04.000Z' })
  recordedAt: string;
}

export class DeliveryEtaDto {
  @ApiProperty({
    example: 'DROPOFF',
    enum: ['PICKUP', 'DROPOFF'],
    description: 'Which stop the driver is heading to.',
  })
  heading: 'PICKUP' | 'DROPOFF';

  @ApiProperty({ example: 640, description: 'Estimated seconds until arrival.' })
  seconds: number;

  @ApiProperty({ example: 2_310, description: 'Remaining road metres.' })
  distanceMeters: number;

  @ApiProperty({ example: '2026-09-03T09:22:44.000Z' })
  arrivingAt: string;
}

export class DeliveryTrackingDto {
  @ApiProperty()
  deliveryId: string;

  @ApiProperty({ example: 'ORD-20260903-00128' })
  bookingCode: string;

  @ApiProperty({ enum: DeliveryStatus })
  status: DeliveryStatus;

  @ApiProperty({ type: DeliveryStopViewDto })
  pickup: DeliveryStopViewDto;

  @ApiProperty({ type: DeliveryStopViewDto })
  dropoff: DeliveryStopViewDto;

  @ApiPropertyOptional({ nullable: true, type: DeliveryDriverViewDto })
  driver: DeliveryDriverViewDto | null;

  @ApiPropertyOptional({
    nullable: true,
    type: DriverPositionDto,
    description: 'Latest fix from the live location stream. Null before assignment or once delivered.',
  })
  driverLocation: DriverPositionDto | null;

  @ApiPropertyOptional({
    nullable: true,
    type: DeliveryEtaDto,
    description: 'Only present while a driver is on the way and their position is known.',
  })
  eta: DeliveryEtaDto | null;

  @ApiPropertyOptional({ nullable: true, description: 'Encoded polyline of the booked route.' })
  routePolyline: string | null;

  @ApiPropertyOptional({ nullable: true, type: ProofOfDeliveryViewDto, description: 'Available once delivered.' })
  proofOfDelivery: ProofOfDeliveryViewDto | null;

  @ApiProperty({ type: [DeliveryTimelineEntryDto] })
  timeline: DeliveryTimelineEntryDto[];
}
