import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsLatitude, IsLongitude, IsNumber, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class SearchLocationsQueryDto {
  @ApiProperty({ example: 'Aeon Mall', minLength: 2 })
  @IsString()
  @Length(2, 120)
  query: string;

  @ApiPropertyOptional({ example: 11.5564, description: 'Bias results towards this point.' })
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

  @ApiPropertyOptional({ minimum: 1, maximum: 25, default: 10 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(25)
  @IsOptional()
  limit = 10;
}

export class ReverseGeocodeQueryDto {
  @ApiProperty({ example: 11.5564 })
  @Type(() => Number)
  @IsNumber()
  @IsLatitude()
  latitude: number;

  @ApiProperty({ example: 104.9282 })
  @Type(() => Number)
  @IsNumber()
  @IsLongitude()
  longitude: number;

  @ApiPropertyOptional({ minimum: 10, maximum: 2000, default: 50, description: 'Search radius in metres.' })
  @Type(() => Number)
  @IsInt()
  @Min(10)
  @Max(2_000)
  @IsOptional()
  radiusMeters = 50;
}

export class LocationDto {
  @ApiProperty({ example: 'W:687168292', description: 'Pass this back when booking to keep the exact place.' })
  placeId: string;

  @ApiProperty({ example: 'AEON Mall 3' })
  name: string;

  @ApiProperty({ example: 'AEON Mall 3, មហាវិថី សម្តេច ហ៊ុន សែន, ខណ្ឌដង្កោ, រាជធានីភ្នំពេញ' })
  address: string;

  @ApiProperty({ example: 11.4833948 })
  latitude: number;

  @ApiProperty({ example: 104.9176838 })
  longitude: number;

  @ApiPropertyOptional({ nullable: true })
  street: string | null;

  @ApiPropertyOptional({ nullable: true })
  district: string | null;

  @ApiPropertyOptional({ nullable: true })
  city: string | null;

  @ApiPropertyOptional({ nullable: true })
  state: string | null;

  @ApiPropertyOptional({ nullable: true })
  postcode: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'mall' })
  category: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Straight-line metres from the point given, if any.' })
  distanceMeters?: number;
}
