import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Length, Matches, MaxLength, Min } from 'class-validator';
import { PageQueryDto } from '../../../common/dto/pagination.dto.js';
import { Currency, WithdrawalMethod, WithdrawalStatus } from '../../../generated/prisma/enums.js';

export class UpdateWithdrawalSettingsDto {
  @ApiProperty({ example: 'ABA Bank' })
  @IsString()
  @Length(2, 120)
  bankName: string;

  @ApiProperty({ example: 'CHAN SOPHEAK' })
  @IsString()
  @Length(2, 120)
  accountHolderName: string;

  @ApiProperty({
    example: '000123456789',
    description: 'Stored encrypted; only the last four digits are ever returned.',
  })
  @Matches(/^[0-9\s-]{6,32}$/, { message: 'Account number must be 6 to 32 digits.' })
  accountNumber: string;

  @ApiPropertyOptional({ description: 'File id from POST /mobile/uploads with purpose KHQR_IMAGE.' })
  @IsString()
  @MaxLength(32)
  @IsOptional()
  khqrFileId?: string;
}

export class WithdrawalSettingsDto {
  @ApiPropertyOptional({ nullable: true, example: 'ABA Bank' })
  bankName: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'CHAN SOPHEAK' })
  accountHolderName: string | null;

  @ApiPropertyOptional({ nullable: true, example: '6789', description: 'Last four digits only.' })
  accountNumberLast4: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Presigned URL; expires.' })
  khqrImageUrl: string | null;

  @ApiProperty({ example: true, description: 'Whether a withdrawal can be requested.' })
  isComplete: boolean;

  @ApiPropertyOptional({ nullable: true })
  updatedAt: string | null;
}

export class CreateWithdrawalDto {
  @ApiProperty({ example: 100_000, description: 'Amount to withdraw, in minor units.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amount: number;

  @ApiPropertyOptional({ enum: Currency, default: Currency.KHR })
  @IsEnum(Currency)
  @IsOptional()
  currency: Currency = Currency.KHR;

  @ApiPropertyOptional({ enum: WithdrawalMethod, default: WithdrawalMethod.BANK_TRANSFER })
  @IsEnum(WithdrawalMethod)
  @IsOptional()
  method: WithdrawalMethod = WithdrawalMethod.BANK_TRANSFER;
}

export class ListWithdrawalsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: WithdrawalStatus })
  @IsEnum(WithdrawalStatus)
  @IsOptional()
  status?: WithdrawalStatus;
}

export class WithdrawalDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: WithdrawalStatus })
  status: WithdrawalStatus;

  @ApiProperty({ enum: WithdrawalMethod })
  method: WithdrawalMethod;

  @ApiProperty({ example: 100_000 })
  amount: number;

  @ApiProperty({ example: 0 })
  fee: number;

  @ApiProperty({ example: 100_000, description: 'What will actually be transferred.' })
  netAmount: number;

  @ApiProperty({ enum: Currency })
  currency: Currency;

  @ApiPropertyOptional({ nullable: true })
  bankName: string | null;

  @ApiPropertyOptional({ nullable: true })
  accountHolderName: string | null;

  @ApiPropertyOptional({ nullable: true, example: '6789' })
  accountNumberLast4: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Why it was rejected or failed.' })
  failureReason: string | null;

  @ApiProperty({ example: true, description: 'Whether the driver can still cancel it.' })
  canCancel: boolean;

  @ApiProperty()
  requestedAt: string;

  @ApiPropertyOptional({ nullable: true })
  processedAt: string | null;

  @ApiPropertyOptional({ nullable: true })
  completedAt: string | null;
}
