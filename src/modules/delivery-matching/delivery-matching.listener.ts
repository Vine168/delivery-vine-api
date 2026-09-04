import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEvent } from '../../common/constants/events.js';
import type { TransitionResult } from '../deliveries/delivery-state.service.js';
import { DeliveryMatchingService } from './delivery-matching.service.js';
import { MatchingDispatcher } from './matching.dispatcher.js';

/**
 * Connects the delivery lifecycle to matching without either module importing
 * the other — the delivery service announces what happened, and matching
 * decides what that means for it.
 */
@Injectable()
export class DeliveryMatchingListener {
  private readonly logger = new Logger(DeliveryMatchingListener.name);

  constructor(
    private readonly dispatcher: MatchingDispatcher,
    private readonly matching: DeliveryMatchingService,
  ) {}

  @OnEvent(DomainEvent.DELIVERY_CONFIRMED)
  async onConfirmed(event: TransitionResult): Promise<void> {
    await this.dispatcher.startSearch(event.deliveryId, event.at.getTime());
  }

  @OnEvent(DomainEvent.DELIVERY_CANCELLED)
  async onCancelled(event: TransitionResult): Promise<void> {
    const cancelled = await this.matching.cancelOutstandingOffers(event.deliveryId);
    if (cancelled > 0) {
      this.logger.log(`${event.bookingCode}: withdrew ${cancelled} outstanding offer(s)`);
    }
  }
}
