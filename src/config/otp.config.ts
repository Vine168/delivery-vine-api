import { registerAs } from '@nestjs/config';

export const otpConfig = registerAs('otp', () => ({
  length: Number(process.env.OTP_LENGTH ?? 6),
  ttlSeconds: Number(process.env.OTP_TTL_SECONDS ?? 300),
  maxAttempts: Number(process.env.OTP_MAX_ATTEMPTS ?? 5),
  resendCooldownSeconds: Number(process.env.OTP_RESEND_COOLDOWN_SECONDS ?? 60),
  maxPerHour: Number(process.env.OTP_MAX_PER_HOUR ?? 5),
  verificationTokenTtlSeconds: Number(process.env.OTP_VERIFICATION_TOKEN_TTL_SECONDS ?? 900),
  /// Development convenience only — validated to be false in production.
  exposeInResponse: process.env.OTP_EXPOSE_IN_RESPONSE === 'true',
}));

export type OtpConfig = ReturnType<typeof otpConfig>;
