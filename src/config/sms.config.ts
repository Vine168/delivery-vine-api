import { registerAs } from '@nestjs/config';

/**
 * PlasGate, the SMS gateway that carries OTP codes.
 *
 * Every value is optional: with none of them set the platform falls back to
 * writing codes to the log, which is how local development works and how it
 * behaved before a provider was chosen.
 */
export const smsConfig = registerAs('sms', () => ({
  baseUrl: process.env.PLASGATE_BASE_URL ?? 'https://cloudapi.plasgate.com/rest/send',
  privateKey: process.env.PLASGATE_PRIVATE_KEY,
  secretKey: process.env.PLASGATE_SECRET_KEY,
  /** The name recipients see. Registered with the provider, not free text. */
  sender: process.env.PLASGATE_SENDER,
  timeoutMs: Number(process.env.PLASGATE_TIMEOUT_MS ?? 10_000),
}));

export type SmsConfig = ReturnType<typeof smsConfig>;
