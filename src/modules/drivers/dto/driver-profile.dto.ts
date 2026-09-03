import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import {
  DocumentReviewStatus,
  DriverApprovalStatus,
  DriverAvailabilityStatus,
  DriverDocumentType,
  UserStatus,
} from '../../../generated/prisma/enums.js';

export class UpdateDriverProfileDto {
  @ApiPropertyOptional({ example: 'Chan Sopheak' })
  @IsString()
  @Length(1, 120)
  @IsOptional()
  fullName?: string;

  @ApiPropertyOptional({ example: 'sopheak@example.com', nullable: true })
  @Transform(({ value }) => (value === null || value === '' ? null : String(value).trim().toLowerCase()))
  @IsEmail({}, { message: 'Email address is invalid.' })
  @IsOptional()
  email?: string | null;
}

export class UpdateDriverAvatarDto {
  @ApiProperty({ description: 'File id from POST /mobile/uploads with purpose DRIVER_AVATAR.' })
  @IsString()
  @MaxLength(32)
  fileId: string;
}

export class DriverOnboardingStepDto {
  @ApiProperty({ enum: DriverDocumentType })
  type: DriverDocumentType;

  @ApiProperty({ example: 'National ID (front)' })
  label: string;

  @ApiProperty({ example: true })
  submitted: boolean;

  @ApiProperty({ enum: DocumentReviewStatus, nullable: true })
  status: DocumentReviewStatus | null;
}

export class DriverReadinessDto {
  @ApiProperty({ example: false, description: 'Whether the driver may go online right now.' })
  canGoOnline: boolean;

  @ApiProperty({
    type: [String],
    example: ['DRIVER_DOCUMENTS_INCOMPLETE'],
    description: 'Machine-readable reasons the driver cannot go online.',
  })
  blockers: string[];

  @ApiProperty({ type: [DriverOnboardingStepDto] })
  requiredDocuments: DriverOnboardingStepDto[];

  @ApiProperty({ example: true })
  hasVehicle: boolean;
}

export class DriverStatsDto {
  @ApiProperty({ example: 4.82 })
  ratingAverage: number;

  @ApiProperty({ example: 214 })
  ratingCount: number;

  @ApiProperty({ example: 613 })
  completedDeliveries: number;

  @ApiProperty({ example: 12 })
  cancelledDeliveries: number;

  @ApiProperty({ example: 0.87, description: 'Accepted job offers divided by offers received.' })
  acceptanceRate: number;
}

export class DriverProfileDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  userId: string;

  @ApiProperty({ example: 'Chan Sopheak' })
  fullName: string;

  @ApiProperty({ example: '+85512345678' })
  phone: string;

  @ApiPropertyOptional({ nullable: true })
  email: string | null;

  @ApiPropertyOptional({ nullable: true })
  avatarUrl: string | null;

  @ApiProperty({ enum: DriverApprovalStatus })
  approvalStatus: DriverApprovalStatus;

  @ApiPropertyOptional({ nullable: true, description: 'Why the account was rejected or suspended.' })
  statusReason: string | null;

  @ApiProperty({ enum: DriverAvailabilityStatus })
  availability: DriverAvailabilityStatus;

  @ApiProperty({ enum: UserStatus })
  accountStatus: UserStatus;

  @ApiProperty({ type: DriverStatsDto })
  stats: DriverStatsDto;

  @ApiProperty({ type: DriverReadinessDto })
  readiness: DriverReadinessDto;

  @ApiProperty()
  createdAt: string;
}
