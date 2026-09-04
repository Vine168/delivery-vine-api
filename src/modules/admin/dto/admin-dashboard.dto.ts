import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';
import { Currency, DeliveryStatus } from '../../../generated/prisma/enums.js';

export class AdminDashboardQueryDto {
  @ApiPropertyOptional({
    example: '2026-09-01',
    description: 'Start of the reporting window, in the platform timezone. Defaults to the last 14 days.',
  })
  @IsDateString()
  @IsOptional()
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-09-30', description: 'End of the window, inclusive.' })
  @IsDateString()
  @IsOptional()
  dateTo?: string;
}

export class AdminMoneyTotalDto {
  @ApiProperty({ enum: Currency })
  currency: Currency;

  @ApiProperty({
    example: 1_580_000,
    description: 'Minor units — riels for KHR, cents for USD. Never a decimal.',
  })
  amount: number;
}

export class AdminRevenueDto {
  @ApiProperty({ enum: Currency })
  currency: Currency;

  @ApiProperty({ example: 1_580_000, description: 'What customers were charged, across delivered jobs.' })
  grossAmount: number;

  @ApiProperty({ example: 296_500, description: 'The platform’s share.' })
  commissionAmount: number;

  @ApiProperty({ example: 1_283_500, description: 'What drivers earned.' })
  driverEarningAmount: number;

  @ApiProperty({ example: 100, description: 'Delivered jobs settled in this currency.' })
  deliveredCount: number;

  @ApiProperty({ example: 15_800, description: 'Gross divided by delivered count, rounded to minor units.' })
  averageOrderValue: number;
}

export class AdminStatusCountDto {
  @ApiProperty({ enum: DeliveryStatus })
  status: DeliveryStatus;

  @ApiProperty({ example: 42 })
  count: number;
}

export class AdminDeliveryTotalsDto {
  @ApiProperty({ example: 512, description: 'Bookings created in the window. Drafts are excluded.' })
  total: number;

  @ApiProperty({ example: 430 })
  delivered: number;

  @ApiProperty({ example: 61 })
  cancelled: number;

  @ApiProperty({ example: 9, description: 'Searched to the end of the rounds without a driver.' })
  expired: number;

  @ApiProperty({ example: 12, description: 'In motion right now, regardless of the window.' })
  active: number;

  @ApiProperty({ example: 3, description: 'Looking for a driver right now.' })
  searching: number;

  @ApiProperty({
    example: 8_398,
    description: 'Delivered as a share of finished bookings, in basis points. 8398 is 83.98%.',
  })
  completionRateBps: number;
}

export class AdminDriverTotalsDto {
  @ApiProperty({ example: 240 })
  total: number;

  @ApiProperty({ example: 198, description: 'Approved and able to work.' })
  active: number;

  @ApiProperty({ example: 14 })
  pendingApproval: number;

  @ApiProperty({ example: 6 })
  suspended: number;

  @ApiProperty({ example: 37, description: 'Online this second, from the presence index.' })
  onlineNow: number;

  @ApiProperty({ example: 12, description: 'Online and on a job.' })
  busyNow: number;
}

export class AdminCustomerTotalsDto {
  @ApiProperty({ example: 4_820 })
  total: number;

  @ApiProperty({ example: 96, description: 'Signed up during the window.' })
  newInRange: number;

  @ApiProperty({ example: 612, description: 'Booked at least once during the window.' })
  orderedInRange: number;
}

export class AdminAttentionDto {
  @ApiProperty({ example: 14, description: 'Drivers waiting for an approval decision.' })
  driverApprovals: number;

  @ApiProperty({ example: 23, description: 'Uploaded documents nobody has reviewed.' })
  documentReviews: number;

  @ApiProperty({ example: 7, description: 'Withdrawal requests waiting for a decision.' })
  withdrawals: number;

  @ApiProperty({
    example: 2,
    description: 'Deliveries that have been searching for a driver for more than ten minutes.',
  })
  stalledDeliveries: number;
}

export class AdminTrendPointDto {
  @ApiProperty({ example: '2026-09-03', description: 'A calendar day in the platform timezone.' })
  date: string;

  @ApiProperty({ example: 38 })
  deliveries: number;

  @ApiProperty({ example: 31 })
  delivered: number;

  @ApiProperty({ example: 5 })
  cancelled: number;

  @ApiProperty({ type: [AdminMoneyTotalDto], description: 'Gross revenue that day, one entry per currency.' })
  revenue: AdminMoneyTotalDto[];
}

export class AdminDashboardDto {
  @ApiProperty({ example: '2026-08-21' })
  dateFrom: string;

  @ApiProperty({ example: '2026-09-03' })
  dateTo: string;

  @ApiProperty({ example: 'Asia/Phnom_Penh', description: 'The timezone every date in this payload is read in.' })
  timezone: string;

  @ApiProperty({ type: AdminDeliveryTotalsDto })
  deliveries: AdminDeliveryTotalsDto;

  @ApiProperty({ type: [AdminStatusCountDto], description: 'Every delivery in the window, by status.' })
  statusBreakdown: AdminStatusCountDto[];

  @ApiProperty({
    type: [AdminRevenueDto],
    description:
      'One entry per currency. The platform runs dual-currency, so a single total would be meaningless — these are never summed together.',
  })
  revenue: AdminRevenueDto[];

  @ApiProperty({ type: AdminDriverTotalsDto })
  drivers: AdminDriverTotalsDto;

  @ApiProperty({ type: AdminCustomerTotalsDto })
  customers: AdminCustomerTotalsDto;

  @ApiProperty({ type: AdminAttentionDto, description: 'Queues with someone waiting on an operator.' })
  attention: AdminAttentionDto;

  @ApiProperty({ type: [AdminTrendPointDto], description: 'One point per day, with no gaps.' })
  trend: AdminTrendPointDto[];
}
