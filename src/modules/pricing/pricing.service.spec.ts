import { describe, expect, it } from 'vitest';
import { Currency } from '../../generated/prisma/enums.js';
import { PricingService, type ResolvedPricingRule } from './pricing.service.js';

/** The seeded MOTOR rule for KHR — the numbers a real booking uses. */
const MOTOR_KHR: ResolvedPricingRule = {
  id: 'rule_motor_khr',
  name: 'MOTOR standard (KHR)',
  currency: Currency.KHR,
  baseFare: 4_000,
  includedDistanceMeters: 2_000,
  pricePerKm: 1_000,
  pricePerMinute: 0,
  minimumFare: 4_000,
  waitingFeePerMinute: 0,
  freeWaitingSeconds: 300,
  serviceFeeFlat: 500,
  serviceFeePercentBp: 0,
  codFeeFlat: 0,
  codFeePercentBp: 100,
  commissionPercentBp: 2_000,
  minCommission: 1_000,
  maxCommission: null,
  surgeMultiplierBp: 10_000,
  version: 1,
};

const service = new PricingService(null as never);

const quote = (overrides: Partial<Parameters<PricingService['quote']>[0]> = {}) =>
  service.quote({ rule: MOTOR_KHR, distanceMeters: 2_791, durationSeconds: 457, ...overrides });

describe('PricingService.quote', () => {
  describe('the fare itself', () => {
    it('charges the base fare plus distance beyond the included allowance', () => {
      const price = quote();

      expect(price.baseFare).toBe(4_000);
      expect(price.distanceFare).toBe(791); // 791 m past the 2 km allowance at ៛1,000/km
      expect(price.fareSubtotal).toBe(4_791);
    });

    it('charges nothing for distance inside the allowance', () => {
      expect(quote({ distanceMeters: 1_500 }).distanceFare).toBe(0);
      expect(quote({ distanceMeters: 2_000 }).distanceFare).toBe(0);
    });

    it('applies the minimum fare and says that it did', () => {
      const cheap = quote({ distanceMeters: 300 });

      // base 4,000 already equals the minimum, so nothing is added
      expect(cheap.minimumFareApplied).toBe(false);

      const belowMinimum = service.quote({
        rule: { ...MOTOR_KHR, baseFare: 2_000 },
        distanceMeters: 500,
        durationSeconds: 120,
      });

      expect(belowMinimum.minimumFareApplied).toBe(true);
      expect(belowMinimum.fareSubtotal).toBe(4_000);
      expect(belowMinimum.lines.some((line) => line.code === 'MINIMUM_FARE_ADJUSTMENT')).toBe(true);
    });

    it('applies surge as a multiplier on the fare only', () => {
      const surged = service.quote({
        rule: { ...MOTOR_KHR, surgeMultiplierBp: 12_500 },
        distanceMeters: 2_791,
        durationSeconds: 457,
      });

      expect(surged.surgeAmount).toBe(1_198); // 25% of 4,791
      expect(surged.fareSubtotal).toBe(5_989);
      expect(surged.serviceFee).toBe(500); // flat fee is unaffected
    });
  });

  describe('fees', () => {
    it('adds the service fee outside the fare, so it is not commissionable', () => {
      const price = quote();

      expect(price.serviceFee).toBe(500);
      expect(price.subtotal).toBe(price.fareSubtotal + 500);
      expect(price.commissionAmount).toBeLessThanOrEqual(price.fareSubtotal);
    });

    it('charges a COD fee only when cash is actually being collected', () => {
      expect(quote().codFee).toBe(0);
      expect(quote({ cod: { enabled: false, amount: 40_000 } }).codFee).toBe(0);
      expect(quote({ cod: { enabled: true, amount: 40_000 } }).codFee).toBe(400); // 1%
    });
  });

  describe('discounts', () => {
    it('reduces what the customer pays', () => {
      const withPromo = quote({ discountAmount: 500, promoCode: 'SAVE500' });
      const without = quote();

      expect(withPromo.discountAmount).toBe(500);
      expect(withPromo.totalAmount).toBeLessThan(without.totalAmount);
    });

    it('never reduces the driver’s earning — the platform absorbs promotions', () => {
      const withPromo = quote({ discountAmount: 2_000, promoCode: 'BIG' });
      const without = quote();

      expect(withPromo.driverEarningAmount).toBe(without.driverEarningAmount);
    });

    it('cannot exceed the amount owed, and cannot make a total negative', () => {
      const absurd = quote({ discountAmount: 999_999, promoCode: 'FREE' });

      expect(absurd.discountAmount).toBe(absurd.subtotal);
      expect(absurd.totalAmount).toBe(0);
    });

    it('records the discount as a negative line for the receipt', () => {
      const line = quote({ discountAmount: 500, promoCode: 'SAVE500' }).lines.find((l) => l.code === 'DISCOUNT');

      expect(line?.amount).toBe(-500);
      expect(line?.label).toBe('Promo SAVE500');
    });
  });

  describe('commission', () => {
    it('takes the configured percentage of the fare', () => {
      const price = service.quote({
        rule: { ...MOTOR_KHR, minCommission: null },
        distanceMeters: 12_000,
        durationSeconds: 1_800,
      });

      expect(price.commissionAmount).toBe(Math.round(price.fareSubtotal * 0.2));
      expect(price.driverEarningAmount).toBe(price.fareSubtotal - price.commissionAmount);
    });

    it('respects the minimum commission on a short trip', () => {
      const price = quote();

      // 20% of 4,791 is 958, below the ៛1,000 floor
      expect(price.commissionAmount).toBe(1_000);
      expect(price.driverEarningAmount).toBe(3_791);
    });

    it('respects the maximum commission on a long trip', () => {
      const price = service.quote({
        rule: { ...MOTOR_KHR, maxCommission: 5_000 },
        distanceMeters: 60_000,
        durationSeconds: 5_400,
      });

      expect(price.commissionAmount).toBe(5_000);
    });

    it('can never exceed the fare it is taken from', () => {
      const price = service.quote({
        rule: { ...MOTOR_KHR, minCommission: 999_999 },
        distanceMeters: 2_791,
        durationSeconds: 457,
      });

      expect(price.commissionAmount).toBeLessThanOrEqual(price.fareSubtotal);
      expect(price.driverEarningAmount).toBeGreaterThanOrEqual(0);
    });
  });

  describe('invariants', () => {
    it('produces whole minor units for every amount', () => {
      for (const distance of [0, 137, 2_000, 3_333, 25_781]) {
        const price = quote({ distanceMeters: distance, cod: { enabled: true, amount: 33_333 } });

        for (const [field, value] of Object.entries(price)) {
          if (typeof value === 'number') {
            expect(Number.isInteger(value), `${field} = ${value}`).toBe(true);
          }
        }
      }
    });

    it('rounds the total up to a quotable amount of riel', () => {
      for (const distance of [2_791, 3_333, 4_017]) {
        expect(quote({ distanceMeters: distance }).totalAmount % 100).toBe(0);
      }
    });

    it('leaves US cents unrounded', () => {
      const usd = service.quote({
        rule: { ...MOTOR_KHR, currency: Currency.USD, baseFare: 100, pricePerKm: 25, minimumFare: 100, serviceFeeFlat: 12, minCommission: 25 },
        distanceMeters: 2_791,
        durationSeconds: 457,
      });

      expect(usd.currency).toBe(Currency.USD);
      expect(usd.totalAmount).toBe(usd.subtotal); // no rounding away from the cent
    });

    it('keeps the books balanced: subtotal = fare + fees, total = subtotal − discount', () => {
      const price = quote({ discountAmount: 300, cod: { enabled: true, amount: 40_000 } });

      expect(price.subtotal).toBe(price.fareSubtotal + price.serviceFee + price.codFee);
      expect(price.totalAmount).toBeGreaterThanOrEqual(price.subtotal - price.discountAmount);
    });
  });
});
