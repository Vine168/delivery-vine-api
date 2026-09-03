import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { firstValueFrom } from 'rxjs';
import { ResponseCode } from '../../../common/constants/response-codes.js';
import { AppException } from '../../../common/exceptions/app.exception.js';
import { Currency, PaymentMethod, PaymentStatus } from '../../../generated/prisma/enums.js';
import type { ChargeRequest, ChargeResult, PaymentProvider, VerifyResult } from './payment-provider.interface.js';

/**
 * The exact field order PayWay signs for a purchase. The HMAC is taken over
 * these values concatenated in this order, so it is not a set — reordering or
 * omitting one produces "wrong hash" and nothing else.
 */
const PURCHASE_FIELDS = [
  'req_time',
  'merchant_id',
  'tran_id',
  'amount',
  'items',
  'shipping',
  'firstname',
  'lastname',
  'email',
  'phone',
  'type',
  'payment_option',
  'return_url',
  'cancel_url',
  'continue_success_url',
  'return_deeplink',
  'currency',
  'custom_fields',
  'return_params',
  'payout',
  'lifetime',
  'additional_params',
  'google_pay_token',
  'skip_success_page',
] as const;

type PurchaseFields = Record<(typeof PURCHASE_FIELDS)[number], string>;

interface PurchaseResponse {
  status?: { code?: string | number; message?: string; tran_id?: string };
  qr_string?: string;
  abapay_deeplink?: string;
  checkout_qr_url?: string;
  description?: string;
}

interface CheckResponse {
  status?: {
    code?: number;
    message?: string;
    tran_id?: string;
  };
  data?: {
    payment_status?: string;
    payment_status_code?: number;
    total_amount?: number;
    transaction_date?: string;
    apv?: string;
  };
}

/** PayWay's own transaction-lookup codes. Purchase uses string codes; this uses numbers. */
const CHECK_CODE = {
  SUCCESS: 0,
  WRONG_HASH: 5,
  NOT_FOUND: 6,
} as const;

/** Only these need two decimal places; riel has no minor unit. */
const DECIMAL_CURRENCIES = new Set<Currency>([Currency.USD]);

/**
 * ABA PayWay.
 *
 * KHQR is issued through the merchant's PayWay account rather than built
 * against Bakong directly, so the money settles into their ABA account and the
 * transaction can be verified afterwards.
 *
 * Verified against the live sandbox:
 *  • Every request is signed `base64(HMAC-SHA512(concat(fields), api_key))`
 *    over PURCHASE_FIELDS in order.
 *  • `payment_option=abapay_khqr_deeplink` with `Accept: application/json`
 *    returns `qr_string` and `abapay_deeplink`; the plain `abapay_khqr` option
 *    returns an HTML checkout page instead, which is no use to a mobile app.
 *  • `shipping` must be a number ("0.00"), not an empty string.
 *  • check-transaction-2 answers 6 ("tran_id not found") until the customer
 *    actually pays, so a missing transaction means "not yet", not "failed".
 */
@Injectable()
export class PayWayPaymentProvider implements PaymentProvider {
  readonly method = PaymentMethod.ABA_KHQR;

  private readonly logger = new Logger(PayWayPaymentProvider.name);
  private readonly baseUrl: string;
  private readonly merchantId?: string;
  private readonly apiKey?: string;
  private readonly currencies: Set<string>;
  private readonly lifetimeMinutes: number;
  private readonly returnUrl: string;

  constructor(
    private readonly http: HttpService,
    config: ConfigService,
  ) {
    this.baseUrl = config.get<string>('payment.paywayBaseUrl', 'https://checkout-sandbox.payway.com.kh');
    this.merchantId = config.get<string>('payment.paywayMerchantId') || undefined;
    this.apiKey = config.get<string>('payment.paywayApiKey') || undefined;
    this.currencies = new Set(config.get<string[]>('payment.paywayCurrencies', ['USD']));
    this.lifetimeMinutes = config.get<number>('payment.paywayLifetimeMinutes', 15);
    this.returnUrl = config.get<string>('payment.paywayReturnUrl', '');
  }

  isAvailable(): boolean {
    return Boolean(this.merchantId && this.apiKey);
  }

  unavailableReason(): string | null {
    return this.isAvailable() ? null : 'ABA PayWay is not configured yet.';
  }

  supportsCurrency(currency: Currency): boolean {
    return this.currencies.has(currency);
  }

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    this.assertConfigured();

    // PayWay rejects a currency the merchant account is not enabled for with a
    // generic gateway error; caught here so the message is actionable.
    if (!this.supportsCurrency(request.currency)) {
      throw AppException.unprocessable(
        ResponseCode.PAYMENT_METHOD_NOT_SUPPORTED,
        `ABA PayWay is not enabled for ${request.currency} on this account.`,
      );
    }

    const tranId = this.transactionId(request);
    const expiresAt = new Date(Date.now() + this.lifetimeMinutes * 60_000);

    const fields: PurchaseFields = {
      req_time: this.requestTime(),
      merchant_id: this.merchantId as string,
      tran_id: tranId,
      amount: this.toMajorUnits(request.amount, request.currency),
      items: '',
      // Must be numeric: an empty string is rejected with "Wrong shipping price".
      shipping: this.toMajorUnits(0, request.currency),
      firstname: '',
      lastname: '',
      email: '',
      phone: '',
      type: 'purchase',
      // The deeplink variant answers in JSON; the plain one returns a web page.
      payment_option: 'abapay_khqr_deeplink',
      return_url: this.returnUrl,
      cancel_url: '',
      continue_success_url: '',
      return_deeplink: '',
      currency: request.currency,
      custom_fields: '',
      return_params: request.bookingCode,
      payout: '',
      lifetime: String(this.lifetimeMinutes),
      additional_params: '',
      google_pay_token: '',
      skip_success_page: '',
    };

    const response = await this.post<PurchaseResponse>('purchase', fields, PURCHASE_FIELDS);
    const code = String(response.status?.code ?? '');

    // Purchase reports success as the string "00".
    if (code !== '00') {
      this.logger.error(`PayWay purchase ${tranId} rejected: ${code} ${response.status?.message}`);
      throw AppException.serviceUnavailable(
        ResponseCode.PAYMENT_PROVIDER_ERROR,
        response.status?.message ?? 'The payment provider rejected the request.',
      );
    }

    if (!response.qr_string) {
      throw AppException.serviceUnavailable(
        ResponseCode.PAYMENT_PROVIDER_ERROR,
        'The payment provider did not return a QR code.',
      );
    }

    return {
      status: PaymentStatus.AWAITING_PAYMENT,
      providerRef: tranId,
      qrString: response.qr_string,
      deepLink: response.abapay_deeplink ?? null,
      expiresAt,
      metadata: {
        merchantId: this.merchantId,
        checkoutUrl: response.checkout_qr_url,
        paymentOption: fields.payment_option,
      },
    };
  }

  /**
   * Asks PayWay whether the customer actually paid.
   *
   * PayWay has no record of a transaction until it settles, so "not found" is
   * the normal answer while a QR is still waiting — it is never treated as a
   * failure, and a payment is never marked paid on anything but code 0.
   */
  async verify(paymentRef: string | null, _request: ChargeRequest): Promise<VerifyResult> {
    if (!paymentRef) {
      return { status: PaymentStatus.AWAITING_PAYMENT, message: 'No provider reference to check.' };
    }

    if (!this.isAvailable()) {
      return { status: PaymentStatus.AWAITING_PAYMENT, message: 'ABA PayWay is not configured.' };
    }

    const fields = {
      req_time: this.requestTime(),
      merchant_id: this.merchantId as string,
      tran_id: paymentRef,
    };

    try {
      const response = await this.post<CheckResponse>('check-transaction-2', fields, [
        'req_time',
        'merchant_id',
        'tran_id',
      ]);

      const code = Number(response.status?.code);

      if (code === CHECK_CODE.SUCCESS) {
        return { status: PaymentStatus.PAID, providerRef: paymentRef, raw: response };
      }

      if (code === CHECK_CODE.WRONG_HASH) {
        // Our own credentials are wrong; the customer has done nothing wrong.
        this.logger.error(`PayWay rejected our signature for ${paymentRef} — check PAYWAY_API_KEY`);
        return { status: PaymentStatus.AWAITING_PAYMENT, message: 'Payment verification is misconfigured.' };
      }

      return {
        status: PaymentStatus.AWAITING_PAYMENT,
        message: response.status?.message ?? 'Awaiting payment.',
        raw: response,
      };
    } catch (error) {
      this.logger.warn(`PayWay verification failed for ${paymentRef}: ${String(error)}`);
      // An unreachable gateway is not a failed payment.
      return { status: PaymentStatus.AWAITING_PAYMENT, message: 'Could not reach the payment provider.' };
    }
  }

  // ── Signing and transport ──────────────────────────────────────────────

  /** `base64(HMAC-SHA512(values concatenated in order, api_key))`. */
  sign(values: string[]): string {
    return createHmac('sha512', this.apiKey as string).update(values.join('')).digest('base64');
  }

  private async post<T>(
    endpoint: string,
    fields: Record<string, string>,
    order: readonly string[],
  ): Promise<T> {
    const hash = this.sign(order.map((key) => fields[key] ?? ''));

    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      form.append(key, value);
    }
    form.append('hash', hash);

    const response = await firstValueFrom(
      this.http.post<T>(`${this.baseUrl}/api/payment-gateway/v1/payments/${endpoint}`, form, {
        headers: { Accept: 'application/json' },
        timeout: 15_000,
        // PayWay answers 403 for business rejections; read the body rather than throw.
        validateStatus: () => true,
      }),
    );

    return response.data;
  }

  /** PayWay expects `YYYYMMDDHHmmss` in UTC. */
  private requestTime(): string {
    return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  }

  /**
   * A transaction id unique per attempt and within PayWay's 20-character
   * alphanumeric limit. The booking code makes it recognisable in their
   * dashboard; the payment id keeps a retry from colliding with the first try.
   */
  private transactionId(request: ChargeRequest): string {
    const base = request.bookingCode.replace(/[^A-Za-z0-9]/g, '');
    const suffix = request.paymentId.replace(/[^A-Za-z0-9]/g, '').slice(-4).toUpperCase();
    return `${base}${suffix}`.slice(0, 20);
  }

  private toMajorUnits(amount: number, currency: Currency): string {
    return DECIMAL_CURRENCIES.has(currency) ? (amount / 100).toFixed(2) : String(amount);
  }

  private assertConfigured(): void {
    if (!this.isAvailable()) {
      throw AppException.unprocessable(
        ResponseCode.PAYMENT_METHOD_NOT_SUPPORTED,
        'ABA PayWay is not available. Please pay cash on delivery.',
      );
    }
  }
}
