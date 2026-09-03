import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsLatitude, IsLongitude, IsNumber, IsOptional, Max, Min } from 'class-validator';
import { DriverAvailabilityStatus } from '../../../generated/prisma/enums.js';

/** BUSY is set by the server while a job is active and is not offered here. */
export enum DriverAvailabilityInput {
  ONLINE = 'ONLINE',
  OFFLINE = 'OFFLINE',
}

export class UpdateAvailabilityDto {
  @ApiProperty({ enum: DriverAvailabilityInput })
  @IsEnum(DriverAvailabilityInput, { message: 'Status must be ONLINE or OFFLINE.' })
  status: DriverAvailabilityInput;

  @ApiPropertyOptional({ example: 11.5564, description: 'Where the driver is starting from, so they can be matched immediately.' })
  @Type(() => Number)
  @IsNumber()
  @IsLatitude()
  @IsOptional()
  latitude?: number;

  @ApiPropertyOptional({ example: 104.9282 })
  @Type(() => Number)
  @IsNumber()
  @IsLongitude()
  @IsOptional()
  longitude?: number;
}

export class UpdateDriverLocationDto {
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

  @ApiPropertyOptional({ example: 180, description: 'Degrees clockwise from north.' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(360)
  @IsOptional()
  heading?: number;

  @ApiPropertyOptional({ example: 11.5, description: 'Metres per second.' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(90)
  @IsOptional()
  speed?: number;

  @ApiPropertyOptional({ example: 5, description: 'Reported accuracy in metres.' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @IsOptional()
  accuracy?: number;
}

export class DriverAvailabilityDto {
  @ApiProperty({ enum: DriverAvailabilityStatus })
  status: DriverAvailabilityStatus;

  @ApiPropertyOptional({ nullable: true, description: 'When the current online period began.' })
  onlineSinceAt: string | null;

  @ApiProperty({ example: 0, description: 'Seconds online today.' })
  onlineSecondsToday: number;

  @ApiProperty({ example: true })
  canGoOnline: boolean;

  @ApiProperty({ type: [String], example: [] })
  blockers: string[];
}

export class DriverLocationAckDto {
  @ApiProperty({ example: true })
  accepted: boolean;

  @ApiProperty({ example: false, description: 'Whether this fix was also persisted as a tracking point.' })
  recorded: boolean;

  @ApiPropertyOptional({ nullable: true, description: 'The delivery this fix was attached to, if any.' })
  deliveryId: string | null;
}
