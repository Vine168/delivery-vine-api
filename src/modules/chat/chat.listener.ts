import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEvent } from '../../common/constants/events.js';
import type { TransitionResult } from '../deliveries/delivery-state.service.js';
import { ChatService } from './chat.service.js';

/**
 * A conversation exists for exactly as long as it is useful: opened when the
 * two parties are matched, closed a day after the delivery ends.
 */
@Injectable()
export class ChatListener {
  private readonly logger = new Logger(ChatListener.name);

  constructor(private readonly chat: ChatService) {}

  @OnEvent(DomainEvent.DELIVERY_ASSIGNED)
  async onAssigned(event: TransitionResult): Promise<void> {
    try {
      await this.chat.openForDelivery(event.deliveryId);
    } catch (error) {
      // Never block an assignment because a chat thread could not be opened.
      this.logger.error(`Could not open a conversation for ${event.bookingCode}: ${String(error)}`);
    }
  }

  @OnEvent(DomainEvent.DELIVERY_COMPLETED)
  @OnEvent(DomainEvent.DELIVERY_CANCELLED)
  async onFinished(event: TransitionResult): Promise<void> {
    try {
      await this.chat.closeForDelivery(event.deliveryId);
    } catch (error) {
      this.logger.error(`Could not close the conversation for ${event.bookingCode}: ${String(error)}`);
    }
  }
}
