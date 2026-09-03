import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsString, MaxLength } from 'class-validator';
import { DocumentReviewStatus, DriverDocumentType } from '../../../generated/prisma/enums.js';

export class SubmitDriverDocumentDto {
  @ApiProperty({ enum: DriverDocumentType })
  @IsEnum(DriverDocumentType)
  type: DriverDocumentType;

  @ApiProperty({ description: 'File id from POST /mobile/uploads with purpose DRIVER_DOCUMENT.' })
  @IsString()
  @MaxLength(32)
  fileId: string;
}

export class DriverDocumentDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: DriverDocumentType })
  type: DriverDocumentType;

  @ApiProperty({ example: 'National ID (front)' })
  label: string;

  @ApiProperty({ enum: DocumentReviewStatus })
  status: DocumentReviewStatus;

  @ApiProperty({ description: 'Presigned URL — expires. Documents are never publicly readable.' })
  fileUrl: string | null;

  @ApiProperty({ nullable: true })
  fileUrlExpiresAt: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Why a document was rejected.' })
  reviewNote: string | null;

  @ApiPropertyOptional({ nullable: true })
  reviewedAt: string | null;

  @ApiPropertyOptional({ nullable: true })
  expiresAt: string | null;

  @ApiProperty()
  createdAt: string;

  @ApiProperty({ example: true, description: 'Whether this document is required before going online.' })
  required: boolean;
}
