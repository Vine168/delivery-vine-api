import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
import { DriverApprovalStatus } from '../../../generated/prisma/enums.js';
import {
  DATE_ONLY_MESSAGE,
  DATE_ONLY_RULE,
  DOCUMENT_NUMBER_MESSAGE,
  DOCUMENT_NUMBER_RULE,
  NormaliseDocumentNumber,
  REAL_DATE_MESSAGE,
} from './driver-document.dto.js';
import { ApplicationVehicleDto } from './driver-vehicle.dto.js';
import { UpdateWithdrawalSettingsDto } from '../../withdrawals/dto/withdrawal.dto.js';

/**
 * The rows on the driver application screen.
 *
 * Named for what the driver is asked for, not for how it is stored: "National
 * ID" is a document, "Vehicle" is a record with its own photo and review, and
 * "Banking" is neither. The app should not have to know that to draw a list.
 */
export const DriverApplicationStep = {
  NATIONAL_ID: 'NATIONAL_ID',
  PROFILE_PICTURE: 'PROFILE_PICTURE',
  VEHICLE: 'VEHICLE',
  BANKING: 'BANKING',
  DRIVING_LICENSE: 'DRIVING_LICENSE',
  CERTIFICATE_OF_REGISTRY: 'CERTIFICATE_OF_REGISTRY',
} as const;

export type DriverApplicationStep =
  (typeof DriverApplicationStep)[keyof typeof DriverApplicationStep];

/**
 * How far along one row is.
 *
 * A step nobody reviews — the profile picture, the bank details — goes straight
 * from NOT_SUBMITTED to APPROVED, so the app can render one tick for "done"
 * without caring which steps have a review behind them.
 */
export const DriverApplicationStepStatus = {
  NOT_SUBMITTED: 'NOT_SUBMITTED',
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
} as const;

export type DriverApplicationStepStatus =
  (typeof DriverApplicationStepStatus)[keyof typeof DriverApplicationStepStatus];

export class DriverApplicationStepDto {
  @ApiProperty({ enum: DriverApplicationStep, example: DriverApplicationStep.NATIONAL_ID })
  key: DriverApplicationStep;

  @ApiProperty({ example: 'National ID', description: 'Ready to render; already in the caller’s language.' })
  title: string;

  @ApiProperty({ example: true, description: 'False for the steps a driver may skip and still work.' })
  required: boolean;

  @ApiProperty({ enum: DriverApplicationStepStatus, example: DriverApplicationStepStatus.NOT_SUBMITTED })
  status: DriverApplicationStepStatus;

  @ApiPropertyOptional({
    nullable: true,
    example: 'Photograph is too blurred to read the expiry date',
    description: 'Why it was refused. Present only when the status is REJECTED.',
  })
  note: string | null;

  @ApiProperty({
    example: 'POST /mobile/driver/documents',
    description:
      'Where the app submits this step. Every row is part of the one application, so this is POST /mobile/driver/application throughout — to fix a rejected row, send the form again.',
  })
  endpoint: string;
}

export class DriverApplicationDto {
  @ApiPropertyOptional({
    enum: DriverApprovalStatus,
    nullable: true,
    description: 'Null until the account applies: the screen is then a blank form, every step NOT_SUBMITTED.',
  })
  approvalStatus: DriverApprovalStatus | null;

  @ApiProperty({
    example: false,
    description:
      'Every required step submitted. This is what the Submit button waits for — an operator reviews what follows.',
  })
  canSubmit: boolean;

  @ApiProperty({ example: false, description: 'Reviewed, approved, and free to go online.' })
  canGoOnline: boolean;

  @ApiProperty({
    type: [String],
    example: ['DRIVER_NOT_APPROVED'],
    description: 'The same machine-readable reasons the availability endpoint refuses with.',
  })
  blockers: string[];

  @ApiPropertyOptional({
    nullable: true,
    example: '2026-09-12T04:00:00.000Z',
    description: 'When the completed application was handed in. Null while the driver is still filling it out.',
  })
  submittedAt: string | null;

  @ApiProperty({ type: [DriverApplicationStepDto], description: 'In the order the screen should show them.' })
  steps: DriverApplicationStepDto[];
}

/** The national ID card: the photo, and what is printed on it. */
export class NationalIdDto {
  @ApiProperty({ description: 'File id from POST /mobile/uploads with purpose NATIONAL_ID.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  fileId: string;

  @ApiProperty({
    example: '010203040',
    description:
      'The number on the card, as the driver types it. Spaces and dashes are ignored. Stored encrypted: the operator reviewing the application sees it in full, the app only ever the last four.',
  })
  @NormaliseDocumentNumber()
  @IsString()
  @Matches(DOCUMENT_NUMBER_RULE, { message: DOCUMENT_NUMBER_MESSAGE })
  number: string;

  @ApiProperty({
    example: '2031-05-20',
    description:
      'The expiry date on the card, as YYYY-MM-DD. An ID that has already expired is refused with 422 DRIVER_DOCUMENT_EXPIRED before anything is saved.',
  })
  @Matches(DATE_ONLY_RULE, { message: DATE_ONLY_MESSAGE })
  @IsDateString({ strict: true }, { message: REAL_DATE_MESSAGE })
  expiresAt: string;
}

/** The driving licence, when the driver adds one: the photo and what is printed on it. */
export class DrivingLicenseDto {
  @ApiProperty({ description: 'File id from POST /mobile/uploads with purpose DRIVING_LICENSE.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  fileId: string;

  @ApiProperty({
    example: 'B123456',
    description:
      'The licence number, as printed. Spaces and dashes are ignored. Stored encrypted like the national ID number.',
  })
  @NormaliseDocumentNumber()
  @IsString()
  @Matches(DOCUMENT_NUMBER_RULE, { message: DOCUMENT_NUMBER_MESSAGE })
  number: string;

  @ApiProperty({
    example: '2030-01-31',
    description:
      'The expiry date on the licence, as YYYY-MM-DD. An expired licence is refused with 422 DRIVER_DOCUMENT_EXPIRED before anything is saved.',
  })
  @Matches(DATE_ONLY_RULE, { message: DATE_ONLY_MESSAGE })
  @IsDateString({ strict: true }, { message: REAL_DATE_MESSAGE })
  expiresAt: string;
}

/**
 * The vehicle's certificate of registry, when the driver adds one. Its expiry
 * date is optional: send it when the certificate has one.
 */
export class CertificateOfRegistryDto {
  @ApiProperty({ description: 'File id from POST /mobile/uploads with purpose CERTIFICATE_OF_REGISTRY.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  fileId: string;

  @ApiProperty({
    example: 'PP123456',
    description:
      'The certificate number, as printed. Spaces and dashes are ignored. Stored encrypted like the national ID number.',
  })
  @NormaliseDocumentNumber()
  @IsString()
  @Matches(DOCUMENT_NUMBER_RULE, { message: DOCUMENT_NUMBER_MESSAGE })
  number: string;

  @ApiPropertyOptional({
    example: '2030-01-31',
    description:
      'The expiry date on the certificate, as YYYY-MM-DD, if it has one. An expired certificate is refused with 422 DRIVER_DOCUMENT_EXPIRED before anything is saved.',
  })
  @Matches(DATE_ONLY_RULE, { message: DATE_ONLY_MESSAGE })
  @IsDateString({ strict: true }, { message: REAL_DATE_MESSAGE })
  @IsOptional()
  expiresAt?: string;
}

/**
 * The whole driver application in one body.
 *
 * The only way to apply to drive: everything at once, for a form completed in
 * a single sitting, and the call that makes the account a driver. Every part is
 * checked before any is saved, so a refused form saves nothing. The per-step
 * endpoints remain for a driver changing their details later.
 *
 * Files are uploaded first, as always: every id below comes from
 * `POST /mobile/uploads` with the purpose that part requires. Any mobile
 * account may upload them — sending the application is what makes it a driver.
 */
export class SubmitDriverApplicationDto {
  @ApiProperty({ type: NationalIdDto })
  @ValidateNested()
  @Type(() => NationalIdDto)
  nationalId: NationalIdDto;

  @ApiProperty({ description: 'File id from POST /mobile/uploads with purpose DRIVER_AVATAR.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  avatarFileId: string;

  @ApiProperty({
    type: ApplicationVehicleDto,
    description: 'Every field is required here, brand, model, colour and year included.',
  })
  @ValidateNested()
  @Type(() => ApplicationVehicleDto)
  vehicle: ApplicationVehicleDto;

  @ApiProperty({ type: UpdateWithdrawalSettingsDto })
  @ValidateNested()
  @Type(() => UpdateWithdrawalSettingsDto)
  banking: UpdateWithdrawalSettingsDto;

  @ApiPropertyOptional({
    type: DrivingLicenseDto,
    description: 'Optional. When sent, it needs its number and expiry date, like the national ID.',
  })
  @ValidateNested()
  @Type(() => DrivingLicenseDto)
  @IsOptional()
  drivingLicense?: DrivingLicenseDto;

  @ApiPropertyOptional({
    type: CertificateOfRegistryDto,
    description: 'Optional. When sent, it needs its number; the expiry date is optional.',
  })
  @ValidateNested()
  @Type(() => CertificateOfRegistryDto)
  @IsOptional()
  certificateOfRegistry?: CertificateOfRegistryDto;
}
