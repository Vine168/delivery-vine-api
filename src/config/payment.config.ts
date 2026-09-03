import { registerAs } from '@nestjs/config';

export const paymentConfig = registerAs('payment', () => ({
  /**
   * ABA PayWay. KHQR is issued through the merchant's PayWay account rather
   * than built against Bakong directly, so settlement lands in the merchant's
   * ABA account and the transaction is verifiable through PayWay.
   *
   * Without a merchant id and key the method is not offered at all — the API
   * says so rather than producing a QR nobody can pay.
   */
  paywayBaseUrl: (process.env.PAYWAY_BASE_URL ?? 'https://checkout-sandbox.payway.com.kh').replace(/\/+$/, ''),
  paywayMerchantId: process.env.PAYWAY_MERCHANT_ID,
  paywayApiKey: process.env.PAYWAY_API_KEY,
  /**
   * Currencies the merchant account is enabled for. PayWay rejects anything
   * else with a gateway error, so the check happens here where the message can
   * be useful.
   */
  paywayCurrencies: (process.env.PAYWAY_CURRENCIES ?? 'USD')
    .split(',')
    .map((code) => code.trim().toUpperCase())
    .filter(Boolean),
  /** Minutes a QR stays payable. */
  paywayLifetimeMinutes: Number(process.env.PAYWAY_LIFETIME_MINUTES ?? 15),
  paywayReturnUrl: process.env.PAYWAY_RETURN_URL ?? '',
}));

export const payoutConfig = registerAs('payout', () => ({
  minAmountKhr: Number(process.env.WITHDRAWAL_MIN_AMOUNT_KHR ?? 20_000),
  maxAmountKhr: Number(process.env.WITHDRAWAL_MAX_AMOUNT_KHR ?? 4_000_000),
  feeKhr: Number(process.env.WITHDRAWAL_FEE_KHR ?? 0),
}));

export type PaymentConfig = ReturnType<typeof paymentConfig>;
export type PayoutConfig = ReturnType<typeof payoutConfig>;
