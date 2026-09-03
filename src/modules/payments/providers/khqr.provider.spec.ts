import { describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { HttpService } from '@nestjs/axios';
import { Currency, PaymentStatus } from '../../../generated/prisma/enums.js';
import { KhqrPaymentProvider } from './khqr.provider.js';

const config = (values: Record<string, unknown>): ConfigService =>
  ({ get: <T>(key: string, fallback?: T) => (values[key] as T) ?? fallback }) as ConfigService;

const http = {} as HttpService;

const request = {
  paymentId: 'pay_1',
  bookingCode: 'ORD-20260903-00128',
  amount: 15_800,
  currency: Currency.KHR,
  description: 'Delivery ORD-20260903-00128',
};

describe('KhqrPaymentProvider', () => {
  describe('when no Bakong account is configured', () => {
    const provider = new KhqrPaymentProvider(http, config({}));

    it('reports itself unavailable with a reason', () => {
      expect(provider.isAvailable()).toBe(false);
      expect(provider.unavailableReason()).toContain('not configured');
    });

    it('refuses to charge rather than producing a QR nobody can pay', async () => {
      await expect(provider.charge(request)).rejects.toMatchObject({
        code: 'PAYMENT_METHOD_NOT_SUPPORTED',
      });
    });
  });

  describe('when configured', () => {
    const provider = new KhqrPaymentProvider(
      http,
      config({
        'payment.khqrAccountId': 'merchant@aclb',
        'payment.khqrMerchantName': 'Deliver',
        'payment.khqrMerchantCity': 'Phnom Penh',
        'payment.khqrExpirySeconds': 900,
      }),
    );

    it('is offered', () => {
      expect(provider.isAvailable()).toBe(true);
      expect(provider.unavailableReason()).toBeNull();
    });

    it('builds a scannable KHQR payload carrying the booking code', async () => {
      const result = await provider.charge(request);

      expect(result.status).toBe(PaymentStatus.AWAITING_PAYMENT);
      expect(result.qrString).toMatch(/^00020101/); // EMVCo payload format indicator
      expect(result.qrString).toContain('merchant@aclb');
      expect(result.qrString).toContain(request.bookingCode);
      // The md5 is how Bakong identifies the transaction later.
      expect(result.providerRef).toMatch(/^[0-9a-f]{32}$/);
      expect(result.expiresAt?.getTime()).toBeGreaterThan(Date.now());
    });

    it('sends riel as whole units and dollars as major units', async () => {
      const riel = await provider.charge(request);
      const dollars = await provider.charge({ ...request, amount: 1_250, currency: Currency.USD });

      // 15800 riel and $12.50 — different payloads, both valid.
      expect(riel.qrString).not.toBe(dollars.qrString);
      expect(dollars.qrString).toMatch(/^00020101/);
    });

    it('reports a payment as still awaiting when verification is not configured', async () => {
      const result = await provider.verify('a'.repeat(32), request);

      expect(result.status).toBe(PaymentStatus.AWAITING_PAYMENT);
      expect(result.message).toContain('not configured');
    });

    it('never claims a payment succeeded without a provider reference', async () => {
      const result = await provider.verify(null, request);
      expect(result.status).toBe(PaymentStatus.AWAITING_PAYMENT);
    });
  });
});
