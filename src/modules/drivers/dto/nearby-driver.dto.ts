import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsLatitude, IsLongitude, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class NearbyDriversQueryDto {
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

  @ApiPropertyOptional({ description: 'Restrict to one vehicle type. Defaults to every active type.' })
  @IsString()
  @MaxLength(32)
  @IsOptional()
  vehicleTypeId?: string;

  @ApiPropertyOptional({ minimum: 200, maximum: 20_000, default: 5_000, description: 'Search radius in metres.' })
  @Type(() => Number)
  @IsInt()
  @Min(200)
  @Max(20_000)
  @IsOptional()
  radiusMeters = 5_000;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  @IsOptional()
  limit = 20;
}

/**
 * What a customer may see about a driver they have not booked.
 *
 * No name, no phone number, no plate, no driver id that could be used to
 * address them — just enough to render a moving pin and a vehicle icon.
 */
export class NearbyDriverDto {
  @ApiProperty({ example: 11.5581, description: 'Rounded to about 30 m — precise enough for a pin, not for tailing someone.' })
  latitude: number;

  @ApiProperty({ example: 104.9264 })
  longitude: number;

  @ApiProperty({ example: 'MOTOR' })
  vehicleTypeCode: string;

  @ApiProperty({ example: 640, description: 'Straight-line metres from the point you asked about.' })
  distanceMeters: number;

  @ApiPropertyOptional({ nullable: true, example: 180 })
  heading: number | null;
}
