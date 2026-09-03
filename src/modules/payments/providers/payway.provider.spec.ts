import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { HttpService } from '@nestjs/axios';
import { of } from 'rxjs';
import { Currency, PaymentStatus } from '../../../generated/prisma/enums.js';
import { PayWayPaymentProvider } from './payway.provider.js';

const CONFIGURED = {
  'payment.paywayBaseUrl': 'https://checkout-sandbox.payway.com.kh',
  'payment.paywayMerchantId': 'testmerchant',
  'payment.paywayApiKey': 'test-key',
  'payment.paywayCurrencies': ['USD'],
  'payment.paywayLifetimeMinutes': 15,
  'payment.paywayReturnUrl': '',
};

const config = (values: Record<string, unknown>): ConfigService =>
  ({ get: <T>(key: string, fallback?: T) => (values[key] as T) ?? fallback }) as ConfigService;

/** Captures what would have been posted, and answers with a canned response. */
function stubHttp(response: unknown) {
  const post = vi.fn().mockReturnValue(of({ data: response }));
  return { http: { post } as unknown as HttpService, post };
}

const request = {
  paymentId: 'pay_abcdef123456',
  bookingCode: 'ORD-20260903-00128',
  amount: 383,
  currency: Currency.USD,
  description: 'Delivery ORD-20260903-00128',
};

const purchaseOk = {
  status: { code: '00', message: 'Success!' },
  qr_string: '00020101021230510016abaakhppxxx@abaa…',
  abapay_deeplink: 'abamobilebank://ababank.com?type=payway&qrcode=…',
  checkout_qr_url: 'https://checkout-sandbox.payway.com.kh/abc',
};

const fieldsFrom = (post: ReturnType<typeof stubHttp>['post']): Record<string, string> => {
  const form = post.mock.calls[0][1] as FormData;
  return Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
};

describe('PayWayPaymentProvider', () => {
  describe('when unconfigured', () => {
    const provider = new PayWayPaymentProvider(stubHttp({}).http, config({}));

    it('is not offered', () => {
      expect(provider.isAvailable()).toBe(false);
      expect(provider.unavailableReason()).toContain('not configured');
    });

    it('refuses to charge', async () => {
      await expect(provider.charge(request)).rejects.toMatchObject({
        code: 'PAYMENT_METHOD_NOT_SUPPORTED',
      });
    });
  });

  describe('signing', () => {
    it('is an HMAC-SHA512 of the values concatenated in PayWay’s field order', async () => {
      const { http, post } = stubHttp(purchaseOk);
      const provider = new PayWayPaymentProvider(http, config(CONFIGURED));

      await provider.charge(request);
      const fields = fieldsFrom(post);

      const order = [
        'req_time', 'merchant_id', 'tran_id', 'amount', 'items', 'shipping', 'firstname', 'lastname',
        'email', 'phone', 'type', 'payment_option', 'return_url', 'cancel_url', 'continue_success_url',
        'return_deeplink', 'currency', 'custom_fields', 'return_params', 'payout', 'lifetime',
        'additional_params', 'google_pay_token', 'skip_success_page',
      ];

      const expected = createHmac('sha512', 'test-key')
        .update(order.map((key) => fields[key] ?? '').join(''))
        .digest('base64');

      expect(fields.hash).toBe(expected);
    });

    it('produces a different signature when any signed field changes', async () => {
      const first = stubHttp(purchaseOk);
      const second = stubHttp(purchaseOk);

      await new PayWayPaymentProvider(first.http, config(CONFIGURED)).charge(request);
      await new PayWayPaymentProvider(second.http, config(CONFIGURED)).charge({ ...request, amount: 999 });

      expect(fieldsFrom(first.post).hash).not.toBe(fieldsFrom(second.post).hash);
    });
  });

  describe('request shape', () => {
    it('asks for the deeplink option, which is the one that answers in JSON', async () => {
      const { http, post } = stubHttp(purchaseOk);
      await new PayWayPaymentProvider(http, config(CONFIGURED)).charge(request);

      expect(fieldsFrom(post).payment_option).toBe('abapay_khqr_deeplink');
      expect(post.mock.calls[0][2].headers.Accept).toBe('application/json');
    });

    it('sends money in major units — PayWay does not take cents', async () => {
      const { http, post } = stubHttp(purchaseOk);
      await new PayWayPaymentProvider(http, config(CONFIGURED)).charge(request);

      // 383 cents is $3.83, not 383.
      expect(fieldsFrom(post).amount).toBe('3.83');
    });

    it('sends shipping as a number, because an empty string is rejected', async () => {
      const { http, post } = stubHttp(purchaseOk);
      await new PayWayPaymentProvider(http, config(CONFIGURED)).charge(request);

      expect(fieldsFrom(post).shipping).toBe('0.00');
    });

    it('builds a transaction id that is unique per attempt and within the length limit', async () => {
      const first = stubHttp(purchaseOk);
      const second = stubHttp(purchaseOk);

      await new PayWayPaymentProvider(first.http, config(CONFIGURED)).charge(request);
      await new PayWayPaymentProvider(second.http, config(CONFIGURED)).charge({
        ...request,
        paymentId: 'pay_zzzzzz999999',
      });

      const a = fieldsFrom(first.post).tran_id;
      const b = fieldsFrom(second.post).tran_id;

      expect(a).toMatch(/^[A-Za-z0-9]+$/); // no dashes — PayWay is alphanumeric
      expect(a.length).toBeLessThanOrEqual(20);
      expect(a).toContain('ORD2026090300128');
      expect(a).not.toBe(b); // a retry does not collide with the first attempt
    });

    it('stamps req_time as UTC YYYYMMDDHHmmss', async () => {
      const { http, post } = stubHttp(purchaseOk);
      await new PayWayPaymentProvider(http, config(CONFIGURED)).charge(request);

      expect(fieldsFrom(post).req_time).toMatch(/^\d{14}$/);
    });
  });

  describe('currency', () => {
    it('refuses a currency the merchant account is not enabled for', async () => {
      const { http } = stubHttp(purchaseOk);
      const provider = new PayWayPaymentProvider(http, config(CONFIGURED));

      await expect(provider.charge({ ...request, currency: Currency.KHR })).rejects.toMatchObject({
        code: 'PAYMENT_METHOD_NOT_SUPPORTED',
      });
    });

    it('sends riel as whole units when the account allows KHR', async () => {
      const { http, post } = stubHttp(purchaseOk);
      const provider = new PayWayPaymentProvider(
        http,
        config({ ...CONFIGURED, 'payment.paywayCurrencies': ['KHR', 'USD'] }),
      );

      await provider.charge({ ...request, currency: Currency.KHR, amount: 15_800 });

      expect(fieldsFrom(post).amount).toBe('15800');
      expect(fieldsFrom(post).shipping).toBe('0');
    });
  });

  describe('responses', () => {
    it('returns the QR and deeplink on success', async () => {
      const { http } = stubHttp(purchaseOk);
      const result = await new PayWayPaymentProvider(http, config(CONFIGURED)).charge(request);

      expect(result.status).toBe(PaymentStatus.AWAITING_PAYMENT);
      expect(result.qrString).toBe(purchaseOk.qr_string);
      expect(result.deepLink).toBe(purchaseOk.abapay_deeplink);
      expect(result.expiresAt?.getTime()).toBeGreaterThan(Date.now());
    });

    it('treats any code other than "00" as a provider failure', async () => {
      const { http } = stubHttp({ status: { code: 12, message: 'Payment currency is not allowed.' } });

      await expect(new PayWayPaymentProvider(http, config(CONFIGURED)).charge(request)).rejects.toMatchObject({
        code: 'PAYMENT_PROVIDER_ERROR',
      });
    });

    it('refuses a success that carries no QR', async () => {
      const { http } = stubHttp({ status: { code: '00' } });

      await expect(new PayWayPaymentProvider(http, config(CONFIGURED)).charge(request)).rejects.toMatchObject({
        code: 'PAYMENT_PROVIDER_ERROR',
      });
    });
  });

  describe('verification', () => {
    const verify = (response: unknown) =>
      new PayWayPaymentProvider(stubHttp(response).http, config(CONFIGURED)).verify('ORD202609030012839AB', request);

    it('marks a payment paid only on code 0', async () => {
      expect((await verify({ status: { code: 0 }, data: { payment_status: 'APPROVED' } })).status).toBe(
        PaymentStatus.PAID,
      );
    });

    it('treats "tran_id not found" as still waiting — PayWay has no record until it settles', async () => {
      const result = await verify({ status: { code: 6, message: 'tran_id not found' } });
      expect(result.status).toBe(PaymentStatus.AWAITING_PAYMENT);
    });

    it('never marks a payment paid when our own signature is rejected', async () => {
      const result = await verify({ status: { code: 5, message: 'wrong hash' } });

      expect(result.status).toBe(PaymentStatus.AWAITING_PAYMENT);
      expect(result.message).toContain('misconfigured');
    });

    it('treats an unreachable gateway as unknown, not as failure', async () => {
      const http = { post: vi.fn(() => { throw new Error('ECONNRESET'); }) } as unknown as HttpService;
      const result = await new PayWayPaymentProvider(http, config(CONFIGURED)).verify('T123', request);

      expect(result.status).toBe(PaymentStatus.AWAITING_PAYMENT);
      expect(result.message).toContain('Could not reach');
    });

    it('does nothing without a provider reference', async () => {
      const { http } = stubHttp({});
      const result = await new PayWayPaymentProvider(http, config(CONFIGURED)).verify(null, request);

      expect(result.status).toBe(PaymentStatus.AWAITING_PAYMENT);
    });
  });
});
