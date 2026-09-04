import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { PageQueryDto } from '../../../common/dto/pagination.dto.js';
import {
  Currency,
  DocumentReviewStatus,
  DriverApprovalStatus,
  DriverAvailabilityStatus,
  DriverDocumentType,
  UserStatus,
} from '../../../generated/prisma/enums.js';

export class AdminDriverQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: DriverApprovalStatus, isArray: true })
  @Transform(({ value }) => (Array.isArray(value) ? value : value === undefined ? undefined : [value]))
  @IsEnum(DriverApprovalStatus, { each: true })
  @IsOptional()
  approvalStatus?: DriverApprovalStatus[];

  @ApiPropertyOptional({ enum: DriverAvailabilityStatus })
  @IsEnum(DriverAvailabilityStatus)
  @IsOptional()
  availability?: DriverAvailabilityStatus;

  @ApiPropertyOptional({ description: 'Only drivers assigned to this zone.' })
  @IsString()
  @MaxLength(32)
  @IsOptional()
  zoneId?: string;

  @ApiPropertyOptional({ description: 'Only drivers whose primary vehicle is of this type.' })
  @IsString()
  @MaxLength(32)
  @IsOptional()
  vehicleTypeId?: string;

  @ApiPropertyOptional({ description: 'Matches a name, phone number or plate number.', example: 'Sopheak' })
  @IsString()
  @MaxLength(120)
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({
    description: 'Only drivers with at least one document waiting for review — the approval queue.',
  })
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  @IsOptional()
  awaitingReview?: boolean;

  @ApiPropertyOptional({ example: '2026-09-01', description: 'Signed up on or after this date.' })
  @IsDateString()
  @IsOptional()
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-09-30', description: 'Signed up on or before this date.' })
  @IsDateString()
  @IsOptional()
  dateTo?: string;
}

export class AdminReasonDto {
  @ApiProperty({ example: 'Licence photograph does not match the submitted identity document' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

export class AdminUpdateDriverDto {
  @ApiPropertyOptional({ example: 'Chan Sopheak' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @IsOptional()
  fullName?: string;
}

export class AdminReviewDocumentDto {
  @ApiProperty({
    enum: [DocumentReviewStatus.APPROVED, DocumentReviewStatus.REJECTED],
    description: 'A review decides one way or the other; it cannot put a document back to pending.',
  })
  @IsIn([DocumentReviewStatus.APPROVED, DocumentReviewStatus.REJECTED])
  status: typeof DocumentReviewStatus.APPROVED | typeof DocumentReviewStatus.REJECTED;

  @ApiPropertyOptional({
    example: 'Photograph is too blurred to read the expiry date',
    description: 'Required when rejecting — the driver is shown this.',
  })
  @IsString()
  @MaxLength(500)
  @IsOptional()
  note?: string;
}

export class AdminAssignZonesDto {
  @ApiProperty({
    type: [String],
    description: 'Replaces the driver’s zones outright. An empty array clears them.',
    example: ['zne1a2b3c4d5e6f7g8h9i0j1'],
  })
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  zoneIds: string[];
}

export class AdminZoneSummaryDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'PP-CENTRAL' })
  code: string;

  @ApiProperty({ example: 'Phnom Penh — Central' })
  name: string;
}

export class AdminDriverVehicleDto {
  @ApiProperty()
  id: string;

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

  @ApiProperty({ example: true })
  isPrimary: boolean;

  @ApiProperty({ enum: DocumentReviewStatus })
  status: DocumentReviewStatus;
}

export class AdminDriverDocumentDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: DriverDocumentType })
  type: DriverDocumentType;

  @ApiProperty({ example: 'National ID (front)' })
  label: string;

  @ApiProperty({ enum: DocumentReviewStatus })
  status: DocumentReviewStatus;

  @ApiProperty({
    example: true,
    description: 'Whether a driver cannot go online without this document.',
  })
  required: boolean;

  @ApiPropertyOptional({ nullable: true, description: 'A time-limited link to the uploaded file.' })
  fileUrl: string | null;

  @ApiPropertyOptional({ nullable: true })
  reviewNote: string | null;

  @ApiPropertyOptional({ nullable: true })
  reviewedByName: string | null;

  @ApiPropertyOptional({ nullable: true })
  reviewedAt: string | null;

  @ApiPropertyOptional({ nullable: true })
  expiresAt: string | null;

  @ApiProperty()
  uploadedAt: string;
}

export class AdminWalletBalanceDto {
  @ApiProperty({ enum: Currency })
  currency: Currency;

  @ApiProperty({ example: 128_500, description: 'Minor units.' })
  balance: number;

  @ApiProperty({ example: 20_000, description: 'Held against withdrawals in flight.' })
  reservedBalance: number;

  @ApiProperty({ example: 108_500 })
  availableBalance: number;
}

export class AdminDriverRowDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  userId: string;

  @ApiProperty({ example: 'Chan Sopheak' })
  fullName: string;

  @ApiProperty({ example: '+85512345678' })
  phone: string;

  @ApiPropertyOptional({ nullable: true })
  avatarUrl: string | null;

  @ApiProperty({ enum: DriverApprovalStatus })
  approvalStatus: DriverApprovalStatus;

  @ApiProperty({ enum: UserStatus, description: 'Whether the account itself can sign in.' })
  accountStatus: UserStatus;

  @ApiProperty({ enum: DriverAvailabilityStatus })
  availability: DriverAvailabilityStatus;

  @ApiProperty({
    example: true,
    description: 'Whether the matcher can actually see this driver, from the live presence store.',
  })
  onlineNow: boolean;

  @ApiPropertyOptional({ nullable: true, example: '1AB-2345' })
  plateNumber: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'MOTOR' })
  vehicleTypeCode: string | null;

  @ApiProperty({ example: 4.82 })
  ratingAverage: number;

  @ApiProperty({ example: 214 })
  ratingCount: number;

  @ApiProperty({ example: 1_204 })
  completedDeliveries: number;

  @ApiProperty({ example: 18 })
  cancelledDeliveries: number;

  @ApiProperty({
    example: 7_400,
    description: 'Jobs accepted as a share of jobs offered, in basis points. 7400 is 74%.',
  })
  acceptanceRateBps: number;

  @ApiProperty({ type: [AdminZoneSummaryDto] })
  zones: AdminZoneSummaryDto[];

  @ApiProperty({ example: 0, description: 'Documents waiting for a review decision.' })
  documentsAwaitingReview: number;

  @ApiProperty()
  joinedAt: string;
}

export class AdminDriverDetailDto extends AdminDriverRowDto {
  @ApiPropertyOptional({ nullable: true })
  email: string | null;

  @ApiPropertyOptional({ nullable: true })
  approvedAt: string | null;

  @ApiPropertyOptional({ nullable: true })
  rejectedReason: string | null;

  @ApiPropertyOptional({ nullable: true })
  suspendedReason: string | null;

  @ApiPropertyOptional({ nullable: true })
  lastLoginAt: string | null;

  @ApiProperty({
    example: false,
    description: 'Whether the server would currently let this driver go online.',
  })
  canGoOnline: boolean;

  @ApiProperty({
    type: [String],
    example: ['DRIVER_DOCUMENTS_INCOMPLETE'],
    description: 'Why not — the same checklist the driver app renders.',
  })
  blockers: string[];

  @ApiProperty({ type: [AdminDriverVehicleDto] })
  vehicles: AdminDriverVehicleDto[];

  @ApiProperty({ type: [AdminDriverDocumentDto] })
  documents: AdminDriverDocumentDto[];

  @ApiProperty({ type: [AdminWalletBalanceDto], description: 'One per currency the driver has earned in.' })
  wallets: AdminWalletBalanceDto[];

  @ApiPropertyOptional({ nullable: true, example: 11.5564 })
  lastLatitude: number | null;

  @ApiPropertyOptional({ nullable: true, example: 104.9282 })
  lastLongitude: number | null;

  @ApiPropertyOptional({ nullable: true })
  lastSeenAt: string | null;

  @ApiProperty({ example: 1, description: 'Deliveries this driver is holding right now.' })
  activeDeliveries: number;
}
