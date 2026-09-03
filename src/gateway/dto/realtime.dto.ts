import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsLatitude, IsLongitude, IsNumber, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { DeliveryStatus } from '../../generated/prisma/enums.js';

/** Client → server: subscribe to a delivery's live updates. */
export class SubscribeDeliveryDto {
  @IsString()
  @Length(24, 24)
  deliveryId: string;
}

/** Client → server: a driver reporting position over the socket. */
export class SocketLocationDto {
  @Type(() => Number)
  @IsNumber()
  @IsLatitude()
  latitude: number;

  @Type(() => Number)
  @IsNumber()
  @IsLongitude()
  longitude: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(360)
  @IsOptional()
  heading?: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(90)
  @IsOptional()
  speed?: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @IsOptional()
  accuracy?: number;
}

// ── Server → client payloads (documented for the mobile teams) ───────────

export class DeliveryStatusEventDto {
  @ApiProperty()
  deliveryId: string;

  @ApiProperty({ example: 'ORD-20260903-00128' })
  bookingCode: string;

  @ApiProperty({ enum: DeliveryStatus })
  status: DeliveryStatus;

  @ApiPropertyOptional({ nullable: true, enum: DeliveryStatus })
  previousStatus: DeliveryStatus | null;

  @ApiPropertyOptional({ nullable: true })
  driverId: string | null;

  @ApiProperty()
  at: string;
}

export class DriverLocationEventDto {
  @ApiProperty()
  deliveryId: string;

  @ApiProperty({ example: 11.5575 })
  latitude: number;

  @ApiProperty({ example: 104.9295 })
  longitude: number;

  @ApiPropertyOptional({ nullable: true })
  heading: number | null;

  @ApiPropertyOptional({ nullable: true })
  speed: number | null;

  @ApiProperty()
  at: string;
}

export class JobOfferEventDto {
  @ApiProperty()
  deliveryId: string;

  @ApiProperty()
  assignmentId: string;

  @ApiProperty({ example: 9_600 })
  estimatedEarningAmount: number;

  @ApiProperty({ example: 1_240 })
  distanceToPickupMeters: number;

  @ApiProperty({ description: 'When the offer lapses.' })
  expiresAt: string;
}

export class ConnectionReadyDto {
  @ApiProperty()
  userId: string;

  @ApiProperty({ example: ['user:cm8x…', 'driver:cm9y…'] })
  rooms: string[];

  @ApiProperty()
  serverTime: string;
}
