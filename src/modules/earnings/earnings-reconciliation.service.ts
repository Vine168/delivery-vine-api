import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { DeliveryStatus, EarningStatus } from '../../generated/prisma/enums.js';
import { EarningsService } from './earnings.service.js';

/** How far back a sweep looks. Older than this is a case for a person. */
const LOOKBACK_HOURS = 72;

/** Bounded so one sweep cannot become an unbounded batch job. */
const MAX_PER_RUN = 200;

/**
 * A delivery is DELIVERED and paid for in one transaction, but the driver is
 * settled by an event published *after* that transaction commits. If the
 * process dies in between — a deploy, a crash, an OOM — the delivery is
 * complete and the driver is never paid, and nothing retries.
 *
 * This finds those and settles them. Settlement is already idempotent, keyed
 * on (wallet, reference, type), so re-running it against a delivery that was
 * settled normally does nothing at all; that is what makes a blind sweep safe.
 */
@Injectable()
export class EarningsReconciliationService {
  private readonly logger = new Logger(EarningsReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly earnings: EarningsService,
  ) {}

  async sweep(): Promise<{ missingEarnings: number; unsettledEarnings: number; settled: number }> {
    const since = new Date(Date.now() - LOOKBACK_HOURS * 3_600_000);

    // Two distinct failures. The earning row is written inside the completion
    // transaction, so a missing one means that transaction never committed and
    // the delivery should not be DELIVERED — worth shouting about rather than
    // quietly fixing, because it points at something worse.
    const missing = await this.prisma.delivery.findMany({
      where: {
        status: DeliveryStatus.DELIVERED,
        deliveredAt: { gte: since },
        earning: { is: null },
      },
      select: { id: true, bookingCode: true },
      take: MAX_PER_RUN,
    });

    for (const delivery of missing) {
      this.logger.error(
        `${delivery.bookingCode} is DELIVERED with no earning row — completion did not commit cleanly`,
      );
    }

    // The one this can actually repair: the earning exists but never became a
    // ledger movement, which is exactly what a lost post-commit event leaves.
    const stranded = await this.prisma.driverEarning.findMany({
      where: { status: EarningStatus.PENDING, earnedAt: { gte: since } },
      select: { deliveryId: true, delivery: { select: { bookingCode: true } } },
      take: MAX_PER_RUN,
    });

    let settled = 0;

    for (const earning of stranded) {
      try {
        await this.earnings.settle(earning.deliveryId);
        settled += 1;
        this.logger.warn(`Settled ${earning.delivery.bookingCode} on reconciliation — its event was lost`);
      } catch (error) {
        // One bad row must not stop the sweep; the next run tries again.
        this.logger.error(
          `Could not settle ${earning.delivery.bookingCode} on reconciliation: ${String(error)}`,
        );
      }
    }

    if (missing.length > 0 || settled > 0) {
      this.logger.log(
        `Reconciliation: ${settled} settled, ${missing.length} deliveries with no earning row`,
      );
    }

    return { missingEarnings: missing.length, unsettledEarnings: stranded.length, settled };
  }
}
