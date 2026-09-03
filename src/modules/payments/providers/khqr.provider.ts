import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BakongKHQR, IndividualInfo, khqrData } from 'bakong-khqr';
import { firstValueFrom } from 'rxjs';
import { ResponseCode } from '../../../common/constants/response-codes.js';
import { AppException } from '../../../common/exceptions/app.exception.js';
import { Currency, PaymentMethod, PaymentStatus } from '../../../generated/prisma/enums.js';
import type { ChargeRequest, ChargeResult, PaymentProvider, VerifyResult } from './payment-provider.interface.js';

/** Bakong's numeric currency codes. */
const KHQR_CURRENCY: Record<Currency, number> = {
  [Currency.KHR]: khqrData.currency.khr,
  [Currency.USD]: khqrData.currency.usd,
};

/**
 * ABA / Bakong KHQR.
 *
 * The QR payload is built locally and deterministically from the merchant's
 * Bakong account — no network call, so a customer always gets a scannable code
 * immediately. Confirming that the money arrived is a separate step against
 * Bakong's Open API, keyed by the md5 of the payload.
 *
 * Both halves are configuration-gated. Without a Bakong account id the method
 * is not offered at all; without verification credentials a payment stays
 * AWAITING_PAYMENT rather than being optimistically marked paid. This service
 * never invents a successful payment.
 */
@Injectable()
export class KhqrPaymentProvider implements PaymentProvider {
  readonly method = PaymentMethod.ABA_KHQR;

  private readonly logger = new Logger(KhqrPaymentProvider.name);
  private readonly accountId?: string;
  private readonly merchantName: string;
  private readonly merchantCity: string;
  private readonly expirySeconds: number;
  private readonly verifyUrl?: string;
  private readonly verifyToken?: string;

  constructor(
    private readonly http: HttpService,
    config: ConfigService,
  ) {
    this.accountId = config.get<string>('payment.khqrAccountId') || undefined;
    this.merchantName = config.get<string>('payment.khqrMerchantName', 'Deliver');
    this.merchantCity = config.get<string>('payment.khqrMerchantCity', 'Phnom Penh');
    this.expirySeconds = config.get<number>('payment.khqrExpirySeconds', 900);
    this.verifyUrl = config.get<string>('payment.khqrVerifyUrl') || undefined;
    this.verifyToken = config.get<string>('payment.khqrVerifyToken') || undefined;
  }

  isAvailable(): boolean {
    return Boolean(this.accountId);
  }

  unavailableReason(): string | null {
    return this.isAvailable() ? null : 'KHQR payments are not configured yet.';
  }

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    if (!this.accountId) {
      throw AppException.unprocessable(
        ResponseCode.PAYMENT_METHOD_NOT_SUPPORTED,
        'KHQR payments are not available. Please pay cash on delivery.',
      );
    }

    const expiresAt = new Date(Date.now() + this.expirySeconds * 1000);

    const info = new IndividualInfo(this.accountId, this.merchantName, this.merchantCity, {
      currency: KHQR_CURRENCY[request.currency],
      // KHQR takes the amount in major units; ours are minor.
      amount: this.toMajorUnits(request.amount, request.currency),
      billNumber: request.bookingCode,
      storeLabel: this.merchantName.slice(0, 25),
      terminalLabel: 'API',
      purposeOfTransaction: request.description.slice(0, 25),
      expirationTimestamp: expiresAt.getTime(),
    });

    const generated = new BakongKHQR().generateIndividual(info);

    if (generated.status?.code !== 0 || !generated.data?.qr) {
      this.logger.error(`KHQR generation failed: ${JSON.stringify(generated.status)}`);
      throw AppException.serviceUnavailable(
        ResponseCode.PAYMENT_PROVIDER_ERROR,
        'Could not create a payment QR. Please try again.',
      );
    }

    return {
      status: PaymentStatus.AWAITING_PAYMENT,
      // The md5 is what Bakong identifies the transaction by.
      providerRef: generated.data.md5,
      qrString: generated.data.qr,
      deepLink: null,
      expiresAt,
      metadata: { accountId: this.accountId, billNumber: request.bookingCode },
    };
  }

  /**
   * Asks Bakong whether the transaction settled.
   *
   * With no credentials configured this reports "still waiting" rather than
   * guessing — a payment is never marked paid because we could not check.
   */
  async verify(paymentRef: string | null, _request: ChargeRequest): Promise<VerifyResult> {
    if (!paymentRef) {
      return { status: PaymentStatus.AWAITING_PAYMENT, message: 'No provider reference to check.' };
    }

    if (!this.verifyUrl || !this.verifyToken) {
      return {
        status: PaymentStatus.AWAITING_PAYMENT,
        message: 'Payment verification is not configured.',
      };
    }

    try {
      const response = await firstValueFrom(
        this.http.post<{ responseCode?: number; data?: { hash?: string } }>(
          this.verifyUrl,
          { md5: paymentRef },
          {
            headers: { Authorization: `Bearer ${this.verifyToken}`, 'Content-Type': 'application/json' },
            timeout: 8_000,
          },
        ),
      );

      // Bakong answers 0 for a settled transaction and non-zero otherwise.
      const settled = response.data?.responseCode === 0;

      return {
        status: settled ? PaymentStatus.PAID : PaymentStatus.AWAITING_PAYMENT,
        providerRef: paymentRef,
        raw: response.data,
      };
    } catch (error) {
      this.logger.warn(`KHQR verification failed for ${paymentRef}: ${String(error)}`);
      // An unreachable provider is not a failed payment.
      return { status: PaymentStatus.AWAITING_PAYMENT, message: 'Could not reach the payment provider.' };
    }
  }

  private toMajorUnits(amount: number, currency: Currency): number {
    return currency === Currency.USD ? amount / 100 : amount;
  }
}
