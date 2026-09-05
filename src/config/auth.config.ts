import { registerAs } from '@nestjs/config';

/**
 * Sign-in protection.
 *
 * The route's rate limit is keyed by IP, which stops one machine hammering
 * the API but gives an attacker with many addresses one budget each against
 * the same account. These limits count failures against the account itself.
 */
export const authConfig = registerAs('auth', () => ({
  /** Failures before the account is locked. Generous: people mistype. */
  maxLoginAttempts: Number(process.env.LOGIN_MAX_ATTEMPTS ?? 10),
  /** How long failures are remembered. */
  loginAttemptWindowSeconds: Number(process.env.LOGIN_ATTEMPT_WINDOW_SECONDS ?? 900),
  /** How long the account stays locked once it trips. */
  loginLockSeconds: Number(process.env.LOGIN_LOCK_SECONDS ?? 900),
  /**
   * Whether a refresh must name the device it comes from.
   *
   * A refresh from a *different* device is always refused. This decides what
   * happens when a client names no device at all: older app builds do not send
   * one, so refusing by default would sign their users out the day it ships.
   * Turn it on once the apps in the field are known to send it.
   */
  requireDeviceOnRefresh: process.env.AUTH_REFRESH_REQUIRE_DEVICE === 'true',
}));

export type AuthConfig = ReturnType<typeof authConfig>;
