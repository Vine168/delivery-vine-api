import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';
import { DocumentReviewStatus } from '../../../generated/prisma/enums.js';

export class UpsertDriverVehicleDto {
  @ApiProperty({ description: 'Vehicle type id from GET /mobile/vehicle-types.' })
  @IsString()
  @MaxLength(32)
  vehicleTypeId: string;

  @ApiProperty({ example: '1AB-2345' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  @Length(2, 24)
  plateNumber: string;

  @ApiPropertyOptional({ example: 'Honda' })
  @IsString()
  @MaxLength(60)
  @IsOptional()
  brand?: string;

  @ApiPropertyOptional({ example: 'Dream 125' })
  @IsString()
  @MaxLength(60)
  @IsOptional()
  model?: string;

  @ApiPropertyOptional({ example: 'Black' })
  @IsString()
  @MaxLength(40)
  @IsOptional()
  color?: string;

  @ApiPropertyOptional({ example: 2022 })
  @Type(() => Number)
  @IsInt()
  @Min(1950)
  @Max(2100)
  @IsOptional()
  year?: number;

  @ApiPropertyOptional({ description: 'File id from POST /mobile/uploads with purpose VEHICLE_PHOTO.' })
  @IsString()
  @MaxLength(32)
  @IsOptional()
  photoFileId?: string;
}

export class DriverVehicleDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  vehicleTypeId: string;

  @ApiProperty({ example: 'MOTOR' })
  vehicleTypeCode: string;

  @ApiProperty({ example: 'Motorbike' })
  vehicleTypeName: string;

  @ApiProperty({ example: '1AB-2345' })
  plateNumber: string;

  @ApiPropertyOptional({ nullable: true })
  brand: string | null;

  @ApiPropertyOptional({ nullable: true })
  model: string | null;

  @ApiPropertyOptional({ nullable: true })
  color: string | null;

  @ApiPropertyOptional({ nullable: true })
  year: number | null;

  @ApiPropertyOptional({ nullable: true })
  photoUrl: string | null;

  @ApiProperty({ enum: DocumentReviewStatus, description: 'Review state of the vehicle registration.' })
  status: DocumentReviewStatus;

  @ApiPropertyOptional({ nullable: true })
  reviewNote: string | null;

  @ApiProperty()
  isPrimary: boolean;

  @ApiProperty()
  updatedAt: string;
}
