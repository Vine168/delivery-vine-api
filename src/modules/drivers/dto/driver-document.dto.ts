import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsDateString, IsEnum, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { DocumentReviewStatus, DriverDocumentType } from '../../../generated/prisma/enums.js';

/** Spaces and dashes are how people type a document number, not part of it. */
export const NormaliseDocumentNumber = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.replace(/[\s-]/g, '').toUpperCase() : value));

/** Letters are allowed so a document issued elsewhere still fits. */
export const DOCUMENT_NUMBER_RULE = /^[A-Z0-9]{5,20}$/;
export const DOCUMENT_NUMBER_MESSAGE = 'The document number must be 5 to 20 letters or digits.';

/** An expiry is a day, not a moment. */
export const DATE_ONLY_RULE = /^\d{4}-\d{2}-\d{2}$/;
export const DATE_ONLY_MESSAGE = 'The expiry date must be written as YYYY-MM-DD.';
export const REAL_DATE_MESSAGE = 'The expiry date is not a real date.';

export class SubmitDriverDocumentDto {
  @ApiProperty({ enum: DriverDocumentType })
  @IsEnum(DriverDocumentType)
  type: DriverDocumentType;

  @ApiProperty({
    description:
      'File id from POST /mobile/uploads with the purpose for this type: NATIONAL_ID for a national ID, DRIVING_LICENSE for a driving licence, CERTIFICATE_OF_REGISTRY for a certificate of registry, DRIVER_DOCUMENT for anything else. DRIVER_DOCUMENT is still accepted for all of them here, for builds from before the split.',
  })
  @IsString()
  @MaxLength(32)
  fileId: string;

  @ApiPropertyOptional({
    example: '010203040',
    description:
      'The number printed on the document. Spaces and dashes are ignored. Stored encrypted; the app is only ever shown the last four.',
  })
  @NormaliseDocumentNumber()
  @IsString()
  @Matches(DOCUMENT_NUMBER_RULE, { message: DOCUMENT_NUMBER_MESSAGE })
  @IsOptional()
  documentNumber?: string;

  @ApiPropertyOptional({
    example: '2031-05-20',
    description:
      'The expiry date printed on the document, as YYYY-MM-DD. One that has already passed is refused with 422 DRIVER_DOCUMENT_EXPIRED.',
  })
  @Matches(DATE_ONLY_RULE, { message: DATE_ONLY_MESSAGE })
  @IsDateString({ strict: true }, { message: REAL_DATE_MESSAGE })
  @IsOptional()
  expiresAt?: string;
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

  @ApiPropertyOptional({
    nullable: true,
    example: '3040',
    description: 'The last four characters of the number on the document. The full number is never sent to the app.',
  })
  documentNumberLast4: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Why a document was rejected.' })
  reviewNote: string | null;

  @ApiPropertyOptional({ nullable: true })
  reviewedAt: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: '2031-05-20',
    description: 'The expiry date printed on the document, as YYYY-MM-DD.',
  })
  expiresAt: string | null;

  @ApiProperty()
  createdAt: string;

  @ApiProperty({ example: true, description: 'Whether this document is required before going online.' })
  required: boolean;
}
