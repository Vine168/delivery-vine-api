import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** Where the driver was when they reported the step. Optional but recorded. */
export class StepLocationDto {
  @ApiPropertyOptional({ example: 11.5564 })
  @Type(() => Number)
  @IsNumber()
  @IsLatitude({ message: 'Latitude must be between -90 and 90.' })
  @IsOptional()
  latitude?: number;

  @ApiPropertyOptional({ example: 104.9282 })
  @Type(() => Number)
  @IsNumber()
  @IsLongitude({ message: 'Longitude must be between -180 and 180.' })
  @IsOptional()
  longitude?: number;
}

export class ArrivedDto extends StepLocationDto {}

export class ConfirmPickupDto extends StepLocationDto {
  @ApiPropertyOptional({ example: 'Two boxes collected, one is fragile' })
  @IsString()
  @MaxLength(500)
  @IsOptional()
  note?: string;
}

export class ProofOfDeliveryDto extends StepLocationDto {
  @ApiProperty({ description: 'File id from POST /mobile/uploads with purpose PROOF_OF_DELIVERY.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  photoFileId: string;

  @ApiPropertyOptional({ description: 'Optional signature image, uploaded the same way.' })
  @IsString()
  @MaxLength(32)
  @IsOptional()
  signatureFileId?: string;

  @ApiPropertyOptional({ example: 'Chan Sopheak', description: 'Who actually took the package.' })
  @IsString()
  @MaxLength(120)
  @IsOptional()
  recipientName?: string;

  @ApiPropertyOptional({ example: 'Left with the receptionist' })
  @IsString()
  @MaxLength(500)
  @IsOptional()
  note?: string;
}

export class CompleteDeliveryDto extends StepLocationDto {
  @ApiPropertyOptional({
    example: 40_000,
    description: 'Cash actually collected, in minor units. Required when the delivery is cash on delivery.',
  })
  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  codCollectedAmount?: number;
}

export class DriverCancelJobDto {
  @ApiProperty({ example: 'Vehicle broke down' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  reason: string;
}

export class ProofOfDeliveryViewDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ description: 'Presigned URL; expires.' })
  photoUrl: string;

  @ApiPropertyOptional({ nullable: true })
  signatureUrl: string | null;

  @ApiPropertyOptional({ nullable: true })
  recipientName: string | null;

  @ApiPropertyOptional({ nullable: true })
  note: string | null;

  @ApiPropertyOptional({ nullable: true })
  latitude: number | null;

  @ApiPropertyOptional({ nullable: true })
  longitude: number | null;

  @ApiProperty()
  capturedAt: string;
}
