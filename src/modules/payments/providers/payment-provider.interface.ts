import type { Currency, PaymentMethod, PaymentStatus } from '../../../generated/prisma/enums.js';

export interface ChargeRequest {
  paymentId: string;
  bookingCode: string;
  amount: number;
  currency: Currency;
  description: string;
}

export interface ChargeResult {
  status: PaymentStatus;
  /** The provider's own identifier for this charge, when it has one. */
  providerRef: string | null;
  /** Payload the app renders — a KHQR string, a redirect URL, nothing for cash. */
  qrString?: string | null;
  deepLink?: string | null;
  expiresAt?: Date | null;
  metadata?: Record<string, unknown>;
}

export interface VerifyResult {
  status: PaymentStatus;
  providerRef?: string | null;
  message?: string;
  raw?: unknown;
}

/**
 * What the platform needs from a way of taking money.
 *
 * The delivery and payment services only ever talk to this interface, so ABA
 * specifics — KHQR payload building, Bakong's verification endpoint — stay
 * inside one adapter. Adding a provider is a new class and a registry entry.
 */
export interface PaymentProvider {
  readonly method: PaymentMethod;

  /** False when the provider is not configured; it is then not offered at all. */
  isAvailable(): boolean;

  /** Human-readable reason the method is unavailable, for the methods endpoint. */
  unavailableReason(): string | null;

  charge(request: ChargeRequest): Promise<ChargeResult>;

  /** Asks the provider whether the money actually arrived. */
  verify(paymentRef: string | null, request: ChargeRequest): Promise<VerifyResult>;
}

export const PAYMENT_PROVIDERS = Symbol('PAYMENT_PROVIDERS');
