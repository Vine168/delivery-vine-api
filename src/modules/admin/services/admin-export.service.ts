import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { ResponseCode } from '../../../common/constants/response-codes.js';
import { AppException } from '../../../common/exceptions/app.exception.js';
import { CsvWriter } from '../../../common/utils/csv.util.js';
import { MoneyUtil } from '../../../common/utils/money.util.js';
import { TimeUtil } from '../../../common/utils/time.util.js';
import { PrismaService } from '../../../database/prisma.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import type { Currency } from '../../../generated/prisma/enums.js';
import { AuditService } from '../audit.service.js';

/**
 * How many rows an export may cover.
 *
 * A cap rather than a silent truncation: a file that stops at row 50,000 and
 * looks complete is how a month's revenue quietly goes missing from a report.
 * Past this the operator is asked to narrow the range instead.
 */
const MAX_ROWS = 50_000;

/** Rows fetched per query while streaming. Bounded memory, few round trips. */
const PAGE_SIZE = 1_000;

/**
 * CSV exports.
 *
 * Streamed rather than assembled: the response starts flowing after the first
 * page, so a large export neither holds tens of thousands of rows in memory
 * nor waits in silence long enough for a proxy to give up on it.
 *
 * Money is written twice — the exact minor-unit integer the platform stores,
 * and a decimal string beside it for the person reading the file — with the
 * currency in its own column. Nothing is ever summed across currencies here
 * either; that is the reader's business, and the column tells them which is
 * which.
 */
@Injectable()
export class AdminExportService {
  private readonly logger = new Logger(AdminExportService.name);
  private readonly timezone: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.timezone = config.get<string>('app.timezone', 'Asia/Phnom_Penh');
  }

  async deliveries(
    actorUserId: string,
    where: Prisma.DeliveryWhereInput,
    response: Response,
  ): Promise<void> {
    const total = await this.prisma.delivery.count({ where });
    this.assertExportable(total, 'deliveries');
    await this.record(actorUserId, 'deliveries', total);

    const csv = new CsvWriter(response, [
      'booking_code',
      'status',
      'created_at',
      'delivered_at',
      'customer_name',
      'customer_phone',
      'driver_name',
      'driver_phone',
      'vehicle_type',
      'pickup_address',
      'dropoff_address',
      'distance_meters',
      'currency',
      'total_amount',
      'total_amount_minor',
      'commission_amount',
      'commission_amount_minor',
      'driver_earning',
      'driver_earning_minor',
      'payment_method',
      'payment_status',
    ]);

    csv.start(this.filename('deliveries'));

    await this.stream(
      (cursor) =>
        this.prisma.delivery.findMany({
          where,
          orderBy: { id: 'asc' },
          take: PAGE_SIZE,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: {
            id: true,
            bookingCode: true,
            status: true,
            createdAt: true,
            deliveredAt: true,
            pickupAddress: true,
            dropoffAddress: true,
            distanceMeters: true,
            currency: true,
            totalAmount: true,
            commissionAmount: true,
            driverEarningAmount: true,
            paymentMethod: true,
            paymentStatus: true,
            vehicleType: { select: { code: true } },
            customer: { select: { fullName: true, user: { select: { phone: true } } } },
            driver: { select: { fullName: true, user: { select: { phone: true } } } },
          },
        }),
      (row) => {
        const money = (amount: number) =>
          MoneyUtil.toDecimalString({ amount, currency: row.currency as Currency });

        csv.write([
          row.bookingCode,
          row.status,
          row.createdAt.toISOString(),
          row.deliveredAt?.toISOString(),
          row.customer?.fullName,
          row.customer?.user.phone,
          row.driver?.fullName,
          row.driver?.user.phone,
          row.vehicleType.code,
          row.pickupAddress,
          row.dropoffAddress,
          row.distanceMeters,
          row.currency,
          money(row.totalAmount),
          row.totalAmount,
          money(row.commissionAmount),
          row.commissionAmount,
          money(row.driverEarningAmount),
          row.driverEarningAmount,
          row.paymentMethod,
          row.paymentStatus,
        ]);
      },
    );

    csv.end();
  }

  async drivers(
    actorUserId: string,
    where: Prisma.DriverProfileWhereInput,
    response: Response,
  ): Promise<void> {
    const total = await this.prisma.driverProfile.count({ where });
    this.assertExportable(total, 'drivers');
    await this.record(actorUserId, 'drivers', total);

    const csv = new CsvWriter(response, [
      'driver_id',
      'full_name',
      'phone',
      'email',
      'approval_status',
      'account_status',
      'plate_number',
      'vehicle_type',
      'zones',
      'rating_average',
      'rating_count',
      'completed_deliveries',
      'cancelled_deliveries',
      'acceptance_rate_percent',
      'joined_at',
      'approved_at',
    ]);

    csv.start(this.filename('drivers'));

    await this.stream(
      (cursor) =>
        this.prisma.driverProfile.findMany({
          where,
          orderBy: { id: 'asc' },
          take: PAGE_SIZE,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: {
            id: true,
            fullName: true,
            approvalStatus: true,
            ratingAverage: true,
            ratingCount: true,
            completedDeliveries: true,
            cancelledDeliveries: true,
            offeredJobs: true,
            acceptedJobs: true,
            createdAt: true,
            approvedAt: true,
            user: { select: { phone: true, email: true, status: true } },
            vehicles: {
              where: { isPrimary: true, deletedAt: null },
              take: 1,
              select: { plateNumber: true, vehicleType: { select: { code: true } } },
            },
            zones: { select: { zone: { select: { code: true } } } },
          },
        }),
      (row) => {
        csv.write([
          row.id,
          row.fullName,
          row.user.phone,
          row.user.email,
          row.approvalStatus,
          row.user.status,
          row.vehicles[0]?.plateNumber,
          row.vehicles[0]?.vehicleType.code,
          row.zones.map((assignment) => assignment.zone.code).join(' '),
          Number(row.ratingAverage).toFixed(2),
          row.ratingCount,
          row.completedDeliveries,
          row.cancelledDeliveries,
          row.offeredJobs === 0 ? '0.00' : ((row.acceptedJobs / row.offeredJobs) * 100).toFixed(2),
          row.createdAt.toISOString(),
          row.approvedAt?.toISOString(),
        ]);
      },
    );

    csv.end();
  }

  async customers(
    actorUserId: string,
    where: Prisma.CustomerProfileWhereInput,
    response: Response,
  ): Promise<void> {
    const total = await this.prisma.customerProfile.count({ where });
    this.assertExportable(total, 'customers');
    await this.record(actorUserId, 'customers', total);

    const csv = new CsvWriter(response, [
      'customer_id',
      'full_name',
      'phone',
      'email',
      'account_status',
      'deliveries',
      'joined_at',
    ]);

    csv.start(this.filename('customers'));

    await this.stream(
      (cursor) =>
        this.prisma.customerProfile.findMany({
          where,
          orderBy: { id: 'asc' },
          take: PAGE_SIZE,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: {
            id: true,
            fullName: true,
            createdAt: true,
            user: { select: { phone: true, email: true, status: true } },
            _count: { select: { deliveries: { where: { status: { not: 'DRAFT' } } } } },
          },
        }),
      (row) => {
        csv.write([
          row.id,
          row.fullName,
          row.user.phone,
          row.user.email,
          row.user.status,
          row._count.deliveries,
          row.createdAt.toISOString(),
        ]);
      },
    );

    csv.end();
  }

  async withdrawals(
    actorUserId: string,
    where: Prisma.WithdrawalWhereInput,
    response: Response,
  ): Promise<void> {
    const total = await this.prisma.withdrawal.count({ where });
    this.assertExportable(total, 'withdrawals');
    await this.record(actorUserId, 'withdrawals', total);

    const csv = new CsvWriter(response, [
      'withdrawal_id',
      'requested_at',
      'completed_at',
      'status',
      'method',
      'driver_name',
      'driver_phone',
      'bank_name',
      'account_holder',
      'account_last4',
      'currency',
      'amount',
      'amount_minor',
      'fee',
      'fee_minor',
      'net_amount',
      'net_amount_minor',
      'provider_ref',
      'reason',
    ]);

    csv.start(this.filename('withdrawals'));

    await this.stream(
      (cursor) =>
        this.prisma.withdrawal.findMany({
          where,
          orderBy: { id: 'asc' },
          take: PAGE_SIZE,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: {
            id: true,
            requestedAt: true,
            completedAt: true,
            status: true,
            method: true,
            bankName: true,
            accountHolderName: true,
            accountNumberLast4: true,
            currency: true,
            amount: true,
            fee: true,
            netAmount: true,
            providerRef: true,
            rejectedReason: true,
            failureReason: true,
            driver: { select: { fullName: true, user: { select: { phone: true } } } },
          },
        }),
      (row) => {
        const money = (amount: number) =>
          MoneyUtil.toDecimalString({ amount, currency: row.currency as Currency });

        csv.write([
          row.id,
          row.requestedAt.toISOString(),
          row.completedAt?.toISOString(),
          row.status,
          row.method,
          row.driver.fullName,
          row.driver.user.phone,
          row.bankName,
          row.accountHolderName,
          // Never the full number: the file leaves the building, and the one
          // endpoint that reveals it is separately permissioned and audited.
          row.accountNumberLast4,
          row.currency,
          money(row.amount),
          row.amount,
          money(row.fee),
          row.fee,
          money(row.netAmount),
          row.netAmount,
          row.providerRef,
          row.rejectedReason ?? row.failureReason,
        ]);
      },
    );

    csv.end();
  }

  // ── Internals ──────────────────────────────────────────────────────────

  /**
   * Walks a table by cursor, writing as it goes.
   *
   * Cursor rather than offset: an export of 50,000 rows with OFFSET makes the
   * database re-scan everything it has already skipped, and a row inserted
   * mid-export shifts the window so a record is written twice or not at all.
   */
  private async stream<T extends { id: string }>(
    page: (cursor: string | null) => Promise<T[]>,
    write: (row: T) => void,
  ): Promise<void> {
    let cursor: string | null = null;

    for (;;) {
      const rows: T[] = await page(cursor);
      if (rows.length === 0) return;

      for (const row of rows) write(row);

      if (rows.length < PAGE_SIZE) return;
      cursor = rows.at(-1)?.id ?? null;
    }
  }

  private assertExportable(total: number, what: string): void {
    if (total > MAX_ROWS) {
      throw AppException.unprocessable(
        ResponseCode.EXPORT_TOO_LARGE,
        `That filter covers ${total.toLocaleString('en-US')} ${what}, and an export is limited to ${MAX_ROWS.toLocaleString('en-US')}. Narrow the date range and try again.`,
      );
    }
  }

  private filename(dataset: string): string {
    return `${dataset}-${TimeUtil.dayKey(this.timezone, new Date())}.csv`;
  }

  /**
   * Exports leave the building, so who took what is worth recording.
   *
   * Written before the file starts streaming, not after: once the response has
   * ended there is nothing left to fail into, and an export that happened
   * without a record is exactly the one somebody will ask about later.
   */
  private async record(actorUserId: string, dataset: string, rows: number): Promise<void> {
    await this.audit.record({
      actorUserId,
      action: `export.${dataset}`,
      entityType: 'Export',
      summary: `Exported ${rows} ${dataset} row(s) to CSV`,
      after: { dataset, rows },
    });
  }
}
