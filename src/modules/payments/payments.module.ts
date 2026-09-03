import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
import { CashPaymentProvider } from './providers/cash.provider.js';
import { KhqrPaymentProvider } from './providers/khqr.provider.js';
import { PAYMENT_PROVIDERS } from './providers/payment-provider.interface.js';

/**
 * Adding a payment method means writing one provider and listing it here.
 * Nothing outside this module knows a method exists.
 */
@Module({
  imports: [HttpModule.register({ timeout: 8_000, maxRedirects: 2 })],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    CashPaymentProvider,
    KhqrPaymentProvider,
    {
      provide: PAYMENT_PROVIDERS,
      inject: [CashPaymentProvider, KhqrPaymentProvider],
      useFactory: (cash: CashPaymentProvider, khqr: KhqrPaymentProvider) => [cash, khqr],
    },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
