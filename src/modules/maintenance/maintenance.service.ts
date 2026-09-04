import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';

/**
 * Retention, in days.
 *
 * Track points are the bulk of it: one fix every 20 seconds per driver on a
 * job, kept only so a delivery's route can be replayed for a dispute. Two
 * months is well past the point anyone asks. OTP and idempotency rows are
 * spent within minutes and kept briefly only to make a replay diagnosable.
 */
const RETENTION_DAYS = {
  trackPoints: 60,
  idempotencyKeys: 2,
  otpVerifications: 7,
} as const;

/** Deleted per run, so one sweep cannot lock a hot table for minutes. */
const BATCH = 5_000;

/**
 * Housekeeping for the tables that only ever grow.
 *
 * Every one of these deletes rows nothing reads any more. Deliveries, earnings,
 * ledger entries, audit rows and notifications are all deliberately absent:
 * they are the record of what happened, and their size is a cost of doing
 * business rather than a problem to solve.
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Route history for deliveries long since finished. */
  async pruneTrackPoints(): Promise<number> {
    return this.deleteInBatches('DeliveryTrackPoint', 'recordedAt', RETENTION_DAYS.trackPoints);
  }

  /** Spent request keys — they stop deduplicating anything once expired. */
  async pruneIdempotencyKeys(): Promise<number> {
    return this.deleteInBatches('IdempotencyKey', 'expiresAt', RETENTION_DAYS.idempotencyKeys);
  }

  /** Used and expired verification codes. The hashes are worthless afterwards. */
  async pruneOtpVerifications(): Promise<number> {
    return this.deleteInBatches('OtpVerification', 'expiresAt', RETENTION_DAYS.otpVerifications);
  }

  /**
   * Deletes in bounded batches rather than one statement.
   *
   * A single `DELETE` over months of track points takes a long lock on a table
   * the live tracking path writes to; this gives that path room to breathe
   * between batches, and a run that is interrupted has still made progress.
   */
  private async deleteInBatches(table: string, column: string, days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 86_400_000);
    let removed = 0;

    for (;;) {
      // Identifiers are from the frozen map above, never from a caller.
      const deleted = await this.prisma.$executeRawUnsafe(
        `DELETE FROM "${table}" WHERE "id" IN (
           SELECT "id" FROM "${table}" WHERE "${column}" < $1 LIMIT ${BATCH}
         )`,
        cutoff,
      );

      removed += deleted;
      if (deleted < BATCH) break;
    }

    if (removed > 0) {
      this.logger.log(`Pruned ${removed} row(s) from ${table} older than ${days} days`);
    }

    return removed;
  }
}
