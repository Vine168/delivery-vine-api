import { Module } from '@nestjs/common';
import { DeliveriesModule } from '../deliveries/deliveries.module.js';
import { DeliveryMatchingListener } from './delivery-matching.listener.js';
import { DeliveryMatchingService } from './delivery-matching.service.js';
import { MatchingDispatcher } from './matching.dispatcher.js';
import { MatchingProcessor } from './matching.processor.js';

/**
 * The worker only exists when matching is enabled. BullMQ workers hold a
 * blocking Redis connection permanently, so an API instance (or a test run)
 * that will never dispatch should not start one.
 */
const workers = process.env.MATCHING_ENABLED === 'false' ? [] : [MatchingProcessor];

@Module({
  imports: [DeliveriesModule],
  providers: [DeliveryMatchingService, MatchingDispatcher, DeliveryMatchingListener, ...workers],
  exports: [DeliveryMatchingService, MatchingDispatcher],
})
export class DeliveryMatchingModule {}
