import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';
import { PageQueryDto } from '../../../common/dto/pagination.dto.js';
import {
  Currency,
  EarningStatus,
  LedgerDirection,
  PaymentMethod,
  PaymentProvider,
  PaymentStatus,
  WalletTransactionType,
  WithdrawalMethod,
  WithdrawalStatus,
} from '../../../generated/prisma/enums.js';

export class AdminFinanceQueryDto {
  @ApiPropertyOptional({ example: '2026-09-01', description: 'Defaults to the last 30 days.' })
  @IsDateString()
  @IsOptional()
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-09-30' })
  @IsDateString()
  @IsOptional()
  dateTo?: string;
}

export class AdminWithdrawalQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: WithdrawalStatus, isArray: true })
  @Transform(({ value }) => (Array.isArray(value) ? value : value === undefined ? undefined : [value]))
  @IsEnum(WithdrawalStatus, { each: true })
  @IsOptional()
  status?: WithdrawalStatus[];

  @ApiPropertyOptional({ enum: WithdrawalMethod })
  @IsEnum(WithdrawalMethod)
  @IsOptional()
  method?: WithdrawalMethod;

  @ApiPropertyOptional({ enum: Currency })
  @IsEnum(Currency)
  @IsOptional()
  currency?: Currency;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(32)
  @IsOptional()
  driverId?: string;

  @ApiPropertyOptional({ description: 'Matches a driver name, phone number or account holder name.' })
  @IsString()
  @MaxLength(120)
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({ example: '2026-09-01' })
  @IsDateString()
  @IsOptional()
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-09-30' })
  @IsDateString()
  @IsOptional()
  dateTo?: string;
}

export class AdminEarningQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: EarningStatus })
  @IsEnum(EarningStatus)
  @IsOptional()
  status?: EarningStatus;

  @ApiPropertyOptional({ enum: Currency })
  @IsEnum(Currency)
  @IsOptional()
  currency?: Currency;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(32)
  @IsOptional()
  driverId?: string;

  @ApiPropertyOptional({ example: '2026-09-01' })
  @IsDateString()
  @IsOptional()
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-09-30' })
  @IsDateString()
  @IsOptional()
  dateTo?: string;
}

export class AdminPaymentQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: PaymentStatus, isArray: true })
  @Transform(({ value }) => (Array.isArray(value) ? value : value === undefined ? undefined : [value]))
  @IsEnum(PaymentStatus, { each: true })
  @IsOptional()
  status?: PaymentStatus[];

  @ApiPropertyOptional({ enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  @IsOptional()
  method?: PaymentMethod;

  @ApiPropertyOptional({ enum: PaymentProvider })
  @IsEnum(PaymentProvider)
  @IsOptional()
  provider?: PaymentProvider;

  @ApiPropertyOptional({ enum: Currency })
  @IsEnum(Currency)
  @IsOptional()
  currency?: Currency;

  @ApiPropertyOptional({ description: 'Matches a booking code or a provider reference.' })
  @IsString()
  @MaxLength(120)
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({ example: '2026-09-01' })
  @IsDateString()
  @IsOptional()
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-09-30' })
  @IsDateString()
  @IsOptional()
  dateTo?: string;
}

export class AdminSettleWithdrawalDto {
  @ApiProperty({
    example: 'ABA-TRX-9F2K10',
    description:
      'The bank or provider reference for the transfer that actually happened. Required — a settlement with nothing to point at cannot be reconciled later.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  providerRef: string;
}

export class AdminWalletAdjustmentDto {
  @ApiProperty({ enum: Currency })
  @IsEnum(Currency)
  currency: Currency;

  @ApiProperty({
    enum: LedgerDirection,
    description: 'CREDIT puts money in, DEBIT takes it out. A debit cannot overdraw the wallet.',
  })
  @IsEnum(LedgerDirection)
  direction: LedgerDirection;

  @ApiProperty({ example: 5_000, description: 'Minor units. Must be positive; the direction carries the sign.' })
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  amount: number;

  @ApiProperty({
    example: 'Goodwill credit for delivery ORD-20260903-00128 delayed by a system fault',
    description: 'Shown to the driver on their statement and kept in the audit log.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

export class AdminWalletTransactionQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: Currency })
  @IsEnum(Currency)
  @IsOptional()
  currency?: Currency;

  @ApiPropertyOptional({ enum: WalletTransactionType })
  @IsEnum(WalletTransactionType)
  @IsOptional()
  type?: WalletTransactionType;
}

// ── Responses ────────────────────────────────────────────────────────────

export class AdminRevenueLineDto {
  @ApiProperty({ enum: Currency })
  currency: Currency;

  @ApiProperty({ example: 1_580_000, description: 'Charged to customers across delivered bookings.' })
  grossAmount: number;

  @ApiProperty({ example: 296_500, description: 'The platform’s share.' })
  commissionAmount: number;

  @ApiProperty({ example: 1_283_500, description: 'Owed to drivers for those deliveries.' })
  driverEarningAmount: number;

  @ApiProperty({ example: 42_000, description: 'Cash the drivers collected on delivery.' })
  codCollectedAmount: number;

  @ApiProperty({ example: 100 })
  deliveredCount: number;
}

export class AdminLiabilityLineDto {
  @ApiProperty({ enum: Currency })
  currency: Currency;

  @ApiProperty({
    example: 842_000,
    description: 'Sitting in driver wallets — money the platform owes and has not paid out.',
  })
  walletBalance: number;

  @ApiProperty({ example: 120_000, description: 'Of that, already committed to withdrawals in flight.' })
  reservedBalance: number;

  @ApiProperty({ example: 722_000 })
  availableBalance: number;

  @ApiProperty({ example: 48_000, description: 'Earned but not yet released for withdrawal.' })
  pendingEarnings: number;
}

export class AdminWithdrawalTotalsDto {
  @ApiProperty({ enum: Currency })
  currency: Currency;

  @ApiProperty({ example: 7, description: 'Requests waiting for a decision.' })
  pendingCount: number;

  @ApiProperty({ example: 120_000 })
  pendingAmount: number;

  @ApiProperty({ example: 3, description: 'Approved or processing — decided, not yet paid.' })
  inFlightCount: number;

  @ApiProperty({ example: 60_000 })
  inFlightAmount: number;

  @ApiProperty({ example: 58, description: 'Settled within the window.' })
  settledCount: number;

  @ApiProperty({ example: 1_160_000 })
  settledAmount: number;
}

export class AdminPaymentTotalsDto {
  @ApiProperty({ enum: Currency })
  currency: Currency;

  @ApiProperty({ enum: PaymentMethod })
  method: PaymentMethod;

  @ApiProperty({ enum: PaymentStatus })
  status: PaymentStatus;

  @ApiProperty({ example: 42 })
  count: number;

  @ApiProperty({ example: 663_000 })
  amount: number;
}

export class AdminFinanceOverviewDto {
  @ApiProperty({ example: '2026-08-05' })
  dateFrom: string;

  @ApiProperty({ example: '2026-09-03' })
  dateTo: string;

  @ApiProperty({ example: 'Asia/Phnom_Penh' })
  timezone: string;

  @ApiProperty({
    type: [AdminRevenueLineDto],
    description: 'One line per currency. KHR and USD are never added together.',
  })
  revenue: AdminRevenueLineDto[];

  @ApiProperty({
    type: [AdminLiabilityLineDto],
    description: 'What the platform owes drivers right now — not limited to the window.',
  })
  liabilities: AdminLiabilityLineDto[];

  @ApiProperty({ type: [AdminWithdrawalTotalsDto] })
  withdrawals: AdminWithdrawalTotalsDto[];

  @ApiProperty({ type: [AdminPaymentTotalsDto], description: 'Customer payments, split by method and outcome.' })
  payments: AdminPaymentTotalsDto[];
}

export class AdminWithdrawalRowDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  driverId: string;

  @ApiProperty({ example: 'Chan Sopheak' })
  driverName: string;

  @ApiProperty({ example: '+85512345678' })
  driverPhone: string;

  @ApiProperty({ enum: WithdrawalStatus })
  status: WithdrawalStatus;

  @ApiProperty({ enum: WithdrawalMethod })
  method: WithdrawalMethod;

  @ApiProperty({ example: 100_000, description: 'Requested, in minor units.' })
  amount: number;

  @ApiProperty({ example: 0 })
  fee: number;

  @ApiProperty({ example: 100_000, description: 'What the driver actually receives.' })
  netAmount: number;

  @ApiProperty({ enum: Currency })
  currency: Currency;

  @ApiPropertyOptional({ nullable: true, example: 'ABA Bank' })
  bankName: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'CHAN SOPHEAK' })
  accountHolderName: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: '6789',
    description: 'Only the last four digits. The full number is a separate, audited request.',
  })
  accountNumberLast4: string | null;

  @ApiPropertyOptional({ nullable: true })
  providerRef: string | null;

  @ApiPropertyOptional({ nullable: true })
  rejectedReason: string | null;

  @ApiPropertyOptional({ nullable: true })
  failureReason: string | null;

  @ApiProperty()
  requestedAt: string;

  @ApiPropertyOptional({ nullable: true })
  processedAt: string | null;

  @ApiPropertyOptional({ nullable: true })
  completedAt: string | null;
}

export class AdminWithdrawalDetailDto extends AdminWithdrawalRowDto {
  @ApiProperty({ example: 842_000, description: 'The driver’s wallet balance in this currency.' })
  walletBalance: number;

  @ApiProperty({ example: 120_000 })
  walletReserved: number;

  @ApiProperty({ example: 4, description: 'Withdrawals this driver has already been paid.' })
  previousSettlements: number;
}

export class AdminPayoutDetailsDto {
  @ApiProperty()
  withdrawalId: string;

  @ApiProperty({ example: 'ABA Bank' })
  bankName: string;

  @ApiProperty({ example: 'CHAN SOPHEAK' })
  accountHolderName: string;

  @ApiProperty({
    example: '000123456789',
    description: 'The full account number, decrypted for this request. Reading it is recorded in the audit log.',
  })
  accountNumber: string;

  @ApiProperty({ example: 100_000 })
  netAmount: number;

  @ApiProperty({ enum: Currency })
  currency: Currency;
}

export class AdminEarningRowDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  driverId: string;

  @ApiProperty({ example: 'Chan Sopheak' })
  driverName: string;

  @ApiProperty()
  deliveryId: string;

  @ApiProperty({ example: 'ORD-20260903-00128' })
  bookingCode: string;

  @ApiProperty({ enum: EarningStatus })
  status: EarningStatus;

  @ApiProperty({ enum: Currency })
  currency: Currency;

  @ApiProperty({ example: 15_800, description: 'What the customer paid for the delivery.' })
  deliveryAmount: number;

  @ApiProperty({ example: 2_000, description: 'Commission rate applied, in basis points.' })
  commissionPercentBp: number;

  @ApiProperty({ example: 2_965 })
  commissionAmount: number;

  @ApiProperty({ example: 0 })
  tipAmount: number;

  @ApiProperty({ example: 0 })
  bonusAmount: number;

  @ApiProperty({ example: 11_860, description: 'Credited to the driver’s wallet.' })
  netAmount: number;

  @ApiProperty()
  earnedAt: string;
}

export class AdminPaymentRowDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  deliveryId: string;

  @ApiProperty({ example: 'ORD-20260903-00128' })
  bookingCode: string;

  @ApiProperty({ example: 'Sok Dara' })
  customerName: string;

  @ApiProperty({ enum: PaymentMethod })
  method: PaymentMethod;

  @ApiProperty({ enum: PaymentProvider })
  provider: PaymentProvider;

  @ApiProperty({ enum: PaymentStatus })
  status: PaymentStatus;

  @ApiProperty({ example: 15_800 })
  amount: number;

  @ApiProperty({ enum: Currency })
  currency: Currency;

  @ApiPropertyOptional({ nullable: true })
  providerRef: string | null;

  @ApiPropertyOptional({ nullable: true })
  failureReason: string | null;

  @ApiPropertyOptional({ nullable: true })
  paidAt: string | null;

  @ApiProperty()
  createdAt: string;
}

export class AdminWalletTransactionDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: WalletTransactionType })
  type: WalletTransactionType;

  @ApiProperty({ enum: LedgerDirection })
  direction: LedgerDirection;

  @ApiProperty({ example: 11_860, description: 'Always positive; the direction carries the sign.' })
  amount: number;

  @ApiProperty({ enum: Currency })
  currency: Currency;

  @ApiProperty({ example: 830_140 })
  balanceBefore: number;

  @ApiProperty({ example: 842_000 })
  balanceAfter: number;

  @ApiPropertyOptional({ nullable: true, example: 'delivery' })
  referenceType: string | null;

  @ApiPropertyOptional({ nullable: true })
  referenceId: string | null;

  @ApiPropertyOptional({ nullable: true })
  description: string | null;

  @ApiProperty()
  createdAt: string;
}
