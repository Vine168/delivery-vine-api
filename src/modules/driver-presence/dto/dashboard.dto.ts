import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Currency, DriverAvailabilityStatus } from '../../../generated/prisma/enums.js';

export class DashboardEarningsDto {
  @ApiProperty({ example: 42_500, description: 'Net earnings today, in minor units.' })
  today: number;

  @ApiProperty({ example: 187_000 })
  thisWeek: number;

  @ApiProperty({ enum: Currency })
  currency: Currency;
}

export class DashboardCountsDto {
  @ApiProperty({ example: 2, description: 'Job offers waiting for an answer right now.' })
  newRequests: number;

  @ApiProperty({ example: 1, description: 'Deliveries this driver is currently working.' })
  ongoing: number;

  @ApiProperty({ example: 7, description: 'Completed today.' })
  completedToday: number;

  @ApiProperty({ example: 0, description: 'Cancelled today.' })
  cancelledToday: number;

  @ApiProperty({ example: 613, description: 'Completed since joining.' })
  completedAllTime: number;
}

export class DriverDashboardDto {
  @ApiProperty({ enum: DriverAvailabilityStatus })
  availability: DriverAvailabilityStatus;

  @ApiPropertyOptional({ nullable: true })
  onlineSinceAt: string | null;

  @ApiProperty({ example: 14_400, description: 'Seconds online today.' })
  onlineSecondsToday: number;

  @ApiProperty({ example: 0.87, description: 'Offers accepted ÷ offers received, all time.' })
  acceptanceRate: number;

  @ApiProperty({ example: 4.82 })
  ratingAverage: number;

  @ApiProperty({ example: 214 })
  ratingCount: number;

  @ApiProperty({ type: DashboardEarningsDto })
  earnings: DashboardEarningsDto;

  @ApiProperty({ type: DashboardCountsDto })
  counts: DashboardCountsDto;

  @ApiProperty({ example: true, description: 'Whether the driver may go online right now.' })
  canGoOnline: boolean;

  @ApiProperty({ type: [String] })
  blockers: string[];
}
