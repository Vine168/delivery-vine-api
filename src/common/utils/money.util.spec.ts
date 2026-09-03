import { describe, expect, it } from 'vitest';
import { Currency } from '../../generated/prisma/enums.js';
import { MoneyUtil } from './money.util.js';

describe('MoneyUtil', () => {
  describe('percentOfBp', () => {
    it('applies a basis-point rate as an integer', () => {
      expect(MoneyUtil.percentOfBp(45_000, 2_000)).toBe(9_000); // 20% of 45,000៛
      expect(MoneyUtil.percentOfBp(8_500, 2_941)).toBe(2_500);
    });

    it('rounds rather than truncating, so commission never silently drifts', () => {
      expect(MoneyUtil.percentOfBp(101, 1_500)).toBe(15); // 15.15 → 15
      expect(MoneyUtil.percentOfBp(103, 1_500)).toBe(15); // 15.45 → 15
      expect(MoneyUtil.percentOfBp(107, 1_500)).toBe(16); // 16.05 → 16
    });

    it('never returns a fractional amount', () => {
      for (let amount = 1; amount <= 500; amount += 7) {
        for (const bp of [333, 1_234, 9_999]) {
          expect(Number.isInteger(MoneyUtil.percentOfBp(amount, bp))).toBe(true);
        }
      }
    });
  });

  describe('multiplyBp', () => {
    it('treats 10000 bp as 1.00x', () => {
      expect(MoneyUtil.multiplyBp(7_000, 10_000)).toBe(7_000);
      expect(MoneyUtil.multiplyBp(7_000, 12_500)).toBe(8_750); // 1.25x surge
    });
  });

  describe('arithmetic', () => {
    it('adds and subtracts within one currency', () => {
      const a = MoneyUtil.of(4_500, Currency.KHR);
      const b = MoneyUtil.of(1_500, Currency.KHR);
      expect(MoneyUtil.add(a, b)).toEqual({ amount: 6_000, currency: Currency.KHR });
      expect(MoneyUtil.subtract(a, b)).toEqual({ amount: 3_000, currency: Currency.KHR });
    });

    it('refuses to mix currencies', () => {
      const khr = MoneyUtil.of(4_500, Currency.KHR);
      const usd = MoneyUtil.of(100, Currency.USD);
      expect(() => MoneyUtil.add(khr, usd)).toThrow(/Currency mismatch/);
    });

    it('sums an empty list to zero of the requested currency', () => {
      expect(MoneyUtil.sum([], Currency.USD)).toEqual({ amount: 0, currency: Currency.USD });
    });
  });

  describe('roundToQuotable', () => {
    it('rounds riel up to the nearest 100', () => {
      expect(MoneyUtil.roundToQuotable(7_401, Currency.KHR)).toBe(7_500);
      expect(MoneyUtil.roundToQuotable(7_500, Currency.KHR)).toBe(7_500);
    });

    it('leaves US cents alone', () => {
      expect(MoneyUtil.roundToQuotable(1_237, Currency.USD)).toBe(1_237);
    });
  });

  describe('clamp', () => {
    it('applies min and max commission bounds', () => {
      expect(MoneyUtil.clamp(500, 1_000, 5_000)).toBe(1_000);
      expect(MoneyUtil.clamp(9_000, 1_000, 5_000)).toBe(5_000);
      expect(MoneyUtil.clamp(3_000, null, null)).toBe(3_000);
    });
  });

  describe('convert', () => {
    it('crosses scales correctly (USD cents ↔ riel)', () => {
      const usd = MoneyUtil.of(1_250, Currency.USD); // $12.50
      const { money, rate } = MoneyUtil.convert(usd, Currency.KHR, 4_100);
      expect(money).toEqual({ amount: 51_250, currency: Currency.KHR });
      expect(rate).toBe(4_100);
    });

    it('is a no-op within the same currency', () => {
      const khr = MoneyUtil.of(45_000, Currency.KHR);
      expect(MoneyUtil.convert(khr, Currency.KHR, 999)).toEqual({ money: khr, rate: 1 });
    });
  });

  describe('format', () => {
    it('renders each currency at its own scale', () => {
      expect(MoneyUtil.format({ amount: 45_000, currency: Currency.KHR })).toBe('៛45,000');
      expect(MoneyUtil.format({ amount: 1_250, currency: Currency.USD })).toBe('$12.50');
    });
  });
});
