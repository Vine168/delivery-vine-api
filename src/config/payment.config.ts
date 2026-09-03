import { registerAs } from '@nestjs/config';

export const paymentConfig = registerAs('payment', () => ({
  /**
   * Bakong account that receives payments, e.g. `merchant@aclb`.
   * Without it, KHQR cannot be offered — the API says so rather than
   * producing a QR code that nobody can pay.
   */
  khqrAccountId: process.env.KHQR_ACCOUNT_ID,
  khqrMerchantName: process.env.KHQR_MERCHANT_NAME ?? 'Deliver',
  khqrMerchantCity: process.env.KHQR_MERCHANT_CITY ?? 'Phnom Penh',
  khqrExpirySeconds: Number(process.env.KHQR_EXPIRY_SECONDS ?? 900),
  /** Bakong Open API endpoint used to confirm a payment actually arrived. */
  khqrVerifyUrl: process.env.KHQR_VERIFY_URL,
  khqrVerifyToken: process.env.KHQR_VERIFY_TOKEN,
}));

export const payoutConfig = registerAs('payout', () => ({
  minAmountKhr: Number(process.env.WITHDRAWAL_MIN_AMOUNT_KHR ?? 20_000),
  maxAmountKhr: Number(process.env.WITHDRAWAL_MAX_AMOUNT_KHR ?? 4_000_000),
  feeKhr: Number(process.env.WITHDRAWAL_FEE_KHR ?? 0),
}));

export type PaymentConfig = ReturnType<typeof paymentConfig>;
export type PayoutConfig = ReturnType<typeof payoutConfig>;
