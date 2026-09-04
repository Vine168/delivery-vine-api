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
  /**
   * Comfortably past the 30-day refresh token lifetime.
   *
   * Deliberately not shorter: reuse detection works by finding a token that
   * has already been spent, so deleting spent tokens early would turn a replay
   * attack from "revoke the whole family" into "not found", which is a quieter
   * and much worse answer.
   */
  refreshTokens: 60,
  sessions: 60,
  /** Diagnostics for a push attempt; the notification itself is kept. */
  pushDispatches: 30,
  /**
   * How long an uploaded file may stay attached to nothing.
   *
   * A file is unreferenced for a few seconds between being uploaded and being
   * saved onto the booking that uses it, so this has to be long enough that a
   * slow customer filling in a form is never mistaken for litter.
   */
  orphanedFiles: 7,
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
   * Spent refresh tokens.
   *
   * Tokens rotate on every use, so an app refreshing every fifteen minutes
   * writes some thirty-five thousand rows a year on its own. Nothing has ever
   * deleted them, and this is the table the login path reads.
   */
  async pruneRefreshTokens(): Promise<number> {
    return this.deleteInBatches('RefreshToken', 'expiresAt', RETENTION_DAYS.refreshTokens);
  }

  /**
   * Sessions that ended long ago.
   *
   * Only revoked ones: a session with no `revokedAt` is still someone's open
   * app, however old the row is.
   */
  async pruneSessions(): Promise<number> {
    return this.deleteInBatches('UserSession', 'revokedAt', RETENTION_DAYS.sessions);
  }

  /** The record of individual push attempts. The notification itself stays. */
  async prunePushDispatches(): Promise<number> {
    return this.deleteInBatches('PushDispatch', 'createdAt', RETENTION_DAYS.pushDispatches);
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
