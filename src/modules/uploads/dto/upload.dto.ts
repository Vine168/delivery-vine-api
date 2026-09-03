import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { FilePurpose, FileVisibility } from '../../../generated/prisma/enums.js';

export class CreateUploadDto {
  @ApiProperty({ enum: FilePurpose, description: 'What the file is for. Determines size, type and privacy rules.' })
  @IsEnum(FilePurpose)
  purpose: FilePurpose;
}

export class FileAssetDto {
  @ApiProperty({ example: 'cm8x1a2b3c4d5e6f7g8h9i0j' })
  id: string;

  @ApiProperty({ enum: FilePurpose })
  purpose: FilePurpose;

  @ApiProperty({ enum: FileVisibility })
  visibility: FileVisibility;

  @ApiProperty({ example: 'image/jpeg' })
  mimeType: string;

  @ApiProperty({ example: 248_512 })
  sizeBytes: number;

  @ApiProperty({ description: 'Public URL, or a presigned URL for private files.' })
  url: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'When the presigned URL stops working. Null for public files.',
    example: '2026-09-03T09:15:00.000Z',
  })
  urlExpiresAt: string | null;

  @ApiProperty({ example: '2026-09-03T09:00:00.000Z' })
  createdAt: string;
}
