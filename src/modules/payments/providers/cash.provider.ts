import { Injectable } from '@nestjs/common';
import { PaymentMethod, PaymentStatus } from '../../../generated/prisma/enums.js';
import type { ChargeRequest, ChargeResult, PaymentProvider, VerifyResult } from './payment-provider.interface.js';

/**
 * Cash on delivery.
 *
 * There is no provider to call: the driver collects the money and the delivery
 * is marked paid when they complete it, having confirmed the amount. This class
 * exists so cash is a payment method like any other rather than a special case
 * scattered through the delivery service.
 */
@Injectable()
export class CashPaymentProvider implements PaymentProvider {
  readonly method = PaymentMethod.CASH_ON_DELIVERY;

  isAvailable(): boolean {
    return true;
  }

  unavailableReason(): string | null {
    return null;
  }

  async charge(): Promise<ChargeResult> {
    return {
      // Settled by the driver at the door, not now.
      status: PaymentStatus.PENDING,
      providerRef: null,
      qrString: null,
      deepLink: null,
      expiresAt: null,
    };
  }

  async verify(_ref: string | null, _request: ChargeRequest): Promise<VerifyResult> {
    // Cash is confirmed by the driver completing the delivery; polling tells us
    // nothing the delivery record does not already know.
    return { status: PaymentStatus.PENDING };
  }
}
