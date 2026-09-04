import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsNumber, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';
import { PackageSize } from '../../../generated/prisma/enums.js';

export class CreatePackageTemplateDto {
  @ApiProperty({ example: 'Water crate' })
  @IsString()
  @Length(1, 80)
  name: string;

  @ApiProperty({ enum: PackageSize })
  @IsEnum(PackageSize)
  size: PackageSize;

  @ApiPropertyOptional({ example: 12, description: 'Kilograms.' })
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

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(500)
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ example: 'Keep upright' })
  @IsString()
  @MaxLength(500)
  @IsOptional()
  remarks?: string;

  @ApiPropertyOptional({ description: 'File id from POST /mobile/uploads with purpose PACKAGE_PHOTO.' })
  @IsString()
  @MaxLength(32)
  @IsOptional()
  photoFileId?: string;
}

export class UpdatePackageTemplateDto {
  @ApiPropertyOptional()
  @IsString()
  @Length(1, 80)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ enum: PackageSize })
  @IsEnum(PackageSize)
  @IsOptional()
  size?: PackageSize;

  @ApiPropertyOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1_000)
  @IsOptional()
  weightKg?: number;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(60)
  @IsOptional()
  category?: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(500)
  @IsOptional()
  description?: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(500)
  @IsOptional()
  remarks?: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(32)
  @IsOptional()
  photoFileId?: string;
}

export class PackageTemplateDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'Water crate' })
  name: string;

  @ApiProperty({ enum: PackageSize })
  size: PackageSize;

  @ApiPropertyOptional({ nullable: true })
  weightKg: number | null;

  @ApiPropertyOptional({ nullable: true })
  category: string | null;

  @ApiPropertyOptional({ nullable: true })
  description: string | null;

  @ApiPropertyOptional({ nullable: true })
  remarks: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Presigned URL; expires.' })
  photoUrl: string | null;

  @ApiProperty()
  updatedAt: string;
}
