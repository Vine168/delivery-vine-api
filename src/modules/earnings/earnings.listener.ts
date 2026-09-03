import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEvent } from '../../common/constants/events.js';
import type { TransitionResult } from '../deliveries/delivery-state.service.js';
import { EarningsService } from './earnings.service.js';

/**
 * Pays the driver when a delivery completes.
 *
 * Listening rather than calling keeps the delivery module ignorant of wallets:
 * completing a delivery is a delivery concern, and paying for it is a finance
 * concern.
 */
@Injectable()
export class EarningsListener {
  private readonly logger = new Logger(EarningsListener.name);

  constructor(private readonly earnings: EarningsService) {}

  @OnEvent(DomainEvent.DELIVERY_COMPLETED)
  async onDeliveryCompleted(event: TransitionResult): Promise<void> {
    try {
      await this.earnings.settle(event.deliveryId);
    } catch (error) {
      // The delivery is already complete and the snapshot is written; a failed
      // credit must not unwind it. The earning stays PENDING and can be
      // settled again.
      this.logger.error(`Could not settle earnings for ${event.bookingCode}: ${String(error)}`);
    }
  }
}
