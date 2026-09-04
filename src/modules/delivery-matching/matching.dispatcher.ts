import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { JOB, QUEUE } from '../../common/constants/queues.js';

export interface DispatchRoundJob {
  deliveryId: string;
  round: number;
  /**
   * Which search attempt this job belongs to — the epoch millis of the moment
   * the delivery entered SEARCHING_DRIVER.
   *
   * Job ids are how the queue deduplicates, and completed jobs linger for an
   * hour. Without this, a delivery handed back by its driver (or reassigned by
   * an operator) would ask for round 1 again under an id the queue has already
   * seen, and the request would be silently dropped — the booking would sit in
   * SEARCHING_DRIVER until it expired, never offered to anyone.
   */
  search: number;
}

/**
 * Schedules matching work.
 *
 * Booking a delivery must not wait for driver discovery — that involves Redis
 * geo queries and a call to the map provider — so the HTTP request returns and
 * a queued job does the searching.
 */
@Injectable()
export class MatchingDispatcher {
  private readonly logger = new Logger(MatchingDispatcher.name);
  private readonly enabled: boolean;

  constructor(
    @InjectQueue(QUEUE.DELIVERY_MATCHING) private readonly queue: Queue,
    config: ConfigService,
  ) {
    this.enabled = config.get<boolean>('delivery.matchingEnabled', true);
  }

  async startSearch(deliveryId: string, search: number): Promise<void> {
    if (!this.enabled) {
      this.logger.debug(`Matching disabled; not dispatching ${deliveryId}`);
      return;
    }

    await this.queue.add(
      JOB.DISPATCH_ROUND,
      { deliveryId, round: 1, search },
      // One round 1 per search attempt, however many times the event fires.
      { jobId: this.jobId('dispatch', deliveryId, search, 1) },
    );
  }

  async scheduleNextRound(
    deliveryId: string,
    round: number,
    delaySeconds: number,
    search: number,
  ): Promise<void> {
    if (!this.enabled) return;

    await this.queue.add(
      JOB.DISPATCH_ROUND,
      { deliveryId, round, search },
      { delay: delaySeconds * 1_000, jobId: this.jobId('dispatch', deliveryId, search, round) },
    );
  }

  async scheduleRoundExpiry(
    deliveryId: string,
    round: number,
    delaySeconds: number,
    search: number,
  ): Promise<void> {
    if (!this.enabled) return;

    await this.queue.add(
      JOB.EXPIRE_OFFER,
      { deliveryId, round, search },
      { delay: delaySeconds * 1_000, jobId: this.jobId('expire', deliveryId, search, round) },
    );
  }

  private jobId(kind: string, deliveryId: string, search: number, round: number): string {
    return `${kind}:${deliveryId}:${search}:${round}`;
  }
}
