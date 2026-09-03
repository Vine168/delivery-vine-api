import { Module } from '@nestjs/common';
import { PricingModule } from '../pricing/pricing.module.js';
import { PromoCodesModule } from '../promo-codes/promo-codes.module.js';
import { VehicleTypesModule } from '../vehicle-types/vehicle-types.module.js';
import { BookingCodeService } from './booking-code.service.js';
import { CustomerDeliveriesController } from './customer-deliveries.controller.js';
import { DeliveryExecutionListener } from './delivery-execution.listener.js';
import { DeliveryExecutionService } from './delivery-execution.service.js';
import { DeliveryQuoteService } from './delivery-quote.service.js';
import { DeliveryTrackingService } from './delivery-tracking.service.js';
import { DeliveryStateService } from './delivery-state.service.js';
import { DeliveryMapper } from './delivery.mapper.js';
import { DeliveryService } from './delivery.service.js';

@Module({
  imports: [PricingModule, PromoCodesModule, VehicleTypesModule],
  controllers: [CustomerDeliveriesController],
  providers: [
    DeliveryService,
    DeliveryQuoteService,
    DeliveryStateService,
    DeliveryExecutionService,
    DeliveryExecutionListener,
    DeliveryTrackingService,
    DeliveryMapper,
    BookingCodeService,
  ],
  // The driver-side job endpoints (Phase 4/5) drive the same state machine.
  exports: [
    DeliveryService,
    DeliveryStateService,
    DeliveryQuoteService,
    DeliveryExecutionService,
    DeliveryExecutionListener,
    DeliveryTrackingService,
    DeliveryMapper,
  ],
})
export class DeliveriesModule {}
