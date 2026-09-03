import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { JOB, QUEUE } from '../../common/constants/queues.js';
import { DeliveryMatchingService } from './delivery-matching.service.js';
import { MatchingDispatcher, type DispatchRoundJob } from './matching.dispatcher.js';

/**
 * Runs the search off the request path.
 *
 * Rounds chain themselves: dispatch → wait for the offer window → expire what
 * was not answered → dispatch the next, wider round, until a driver accepts or
 * the rounds run out and the delivery expires.
 */
@Processor(QUEUE.DELIVERY_MATCHING)
export class MatchingProcessor extends WorkerHost {
  private readonly logger = new Logger(MatchingProcessor.name);

  constructor(
    private readonly matching: DeliveryMatchingService,
    private readonly dispatcher: MatchingDispatcher,
  ) {
    super();
  }

  async process(job: Job<DispatchRoundJob>): Promise<void> {
    switch (job.name) {
      case JOB.DISPATCH_ROUND:
        await this.dispatchRound(job.data);
        break;
      case JOB.EXPIRE_OFFER:
        await this.expireRound(job.data);
        break;
      case JOB.EXPIRE_SEARCH:
        await this.matching.expireSearch(job.data.deliveryId);
        break;
      default:
        this.logger.warn(`Unknown matching job: ${job.name}`);
    }
  }

  private async dispatchRound({ deliveryId, round }: DispatchRoundJob): Promise<void> {
    const result = await this.matching.runRound(deliveryId, round);

    if (result.exhausted) return;

    if (result.offersMade > 0) {
      await this.dispatcher.scheduleRoundExpiry(deliveryId, round, this.matching.offerWindowSeconds);
      return;
    }

    // Nobody eligible in range: widen and try again, or give up.
    await this.advance(deliveryId, round);
  }

  private async expireRound({ deliveryId, round }: DispatchRoundJob): Promise<void> {
    const stillSearching = await this.matching.expireRound(deliveryId, round);
    if (!stillSearching) return;

    await this.advance(deliveryId, round);
  }

  private async advance(deliveryId: string, round: number): Promise<void> {
    if (round >= this.matching.roundLimit) {
      await this.matching.expireSearch(deliveryId);
      return;
    }

    await this.dispatcher.scheduleNextRound(deliveryId, round + 1, this.matching.offerWindowSeconds);
  }
}
