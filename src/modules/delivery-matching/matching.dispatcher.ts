import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { JOB, QUEUE } from '../../common/constants/queues.js';

export interface DispatchRoundJob {
  deliveryId: string;
  round: number;
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

  async startSearch(deliveryId: string): Promise<void> {
    if (!this.enabled) {
      this.logger.debug(`Matching disabled; not dispatching ${deliveryId}`);
      return;
    }

    await this.queue.add(
      JOB.DISPATCH_ROUND,
      { deliveryId, round: 1 },
      // One search per delivery, however many times the event fires.
      { jobId: `dispatch:${deliveryId}:1` },
    );
  }

  async scheduleNextRound(deliveryId: string, round: number, delaySeconds: number): Promise<void> {
    if (!this.enabled) return;

    await this.queue.add(
      JOB.DISPATCH_ROUND,
      { deliveryId, round },
      { delay: delaySeconds * 1_000, jobId: `dispatch:${deliveryId}:${round}` },
    );
  }

  async scheduleRoundExpiry(deliveryId: string, round: number, delaySeconds: number): Promise<void> {
    if (!this.enabled) return;

    await this.queue.add(
      JOB.EXPIRE_OFFER,
      { deliveryId, round },
      { delay: delaySeconds * 1_000, jobId: `expire:${deliveryId}:${round}` },
    );
  }
}
