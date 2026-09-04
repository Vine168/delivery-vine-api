import { Currency } from '../../generated/prisma/enums.js';

/**
 * Money is an integer count of a currency's smallest unit, never a float.
 *
 *   KHR 45 000  → { amount: 45000, currency: 'KHR' }   (scale 0, 1 = 1 riel)
 *   USD 12.50   → { amount: 1250,  currency: 'USD' }   (scale 2, 1 = 1 cent)
 */
export interface Money {
  amount: number;
  currency: Currency;
}

const CURRENCY_SCALE: Record<Currency, number> = {
  [Currency.KHR]: 0,
  [Currency.USD]: 2,
};

const CURRENCY_SYMBOL: Record<Currency, string> = {
  [Currency.KHR]: '៛',
  [Currency.USD]: '$',
};

/**
 * Smallest amount a currency can express — also the rounding granularity used
 * when pricing. Riel are not quoted below 100៛ in practice.
 */
const CURRENCY_ROUNDING_UNIT: Record<Currency, number> = {
  [Currency.KHR]: 100,
  [Currency.USD]: 1,
};

export const MoneyUtil = {
  scale(currency: Currency): number {
    return CURRENCY_SCALE[currency];
  },

  of(amount: number, currency: Currency): Money {
    return { amount: Math.trunc(amount), currency };
  },

  zero(currency: Currency): Money {
    return { amount: 0, currency };
  },

  assertSameCurrency(a: Money, b: Money): void {
    if (a.currency !== b.currency) {
      throw new Error(`Currency mismatch: ${a.currency} vs ${b.currency}`);
    }
  },

  add(a: Money, b: Money): Money {
    MoneyUtil.assertSameCurrency(a, b);
    return { amount: a.amount + b.amount, currency: a.currency };
  },

  subtract(a: Money, b: Money): Money {
    MoneyUtil.assertSameCurrency(a, b);
    return { amount: a.amount - b.amount, currency: a.currency };
  },

  sum(items: Money[], currency: Currency): Money {
    return items.reduce<Money>((acc, item) => MoneyUtil.add(acc, item), MoneyUtil.zero(currency));
  },

  /**
   * Applies a basis-point rate. 2000 bp of 45 000៛ = 9 000៛.
   * Rounds half-up on the minor unit — never leaves fractional cents.
   */
  percentOfBp(amount: number, basisPoints: number): number {
    return Math.round((amount * basisPoints) / 10_000);
  },

  /** Multiplies by a basis-point multiplier (10000 = 1.00x). */
  multiplyBp(amount: number, multiplierBp: number): number {
    return Math.round((amount * multiplierBp) / 10_000);
  },

  clamp(amount: number, min?: number | null, max?: number | null): number {
    let result = amount;
    if (min !== undefined && min !== null) result = Math.max(result, min);
    if (max !== undefined && max !== null) result = Math.min(result, max);
    return result;
  },

  /** Rounds a computed fare up to the currency's practical quoting unit. */
  roundToQuotable(amount: number, currency: Currency): number {
    const unit = CURRENCY_ROUNDING_UNIT[currency];
    return Math.ceil(amount / unit) * unit;
  },

  isPositive(amount: number): boolean {
    return Number.isInteger(amount) && amount > 0;
  },

  isNonNegative(amount: number): boolean {
    return Number.isInteger(amount) && amount >= 0;
  },

  /** Presentation only — never feed the result back into a calculation. */
  format(money: Money): string {
    const scale = CURRENCY_SCALE[money.currency];
    const value = money.amount / 10 ** scale;
    const formatted = value.toLocaleString('en-US', {
      minimumFractionDigits: scale,
      maximumFractionDigits: scale,
    });
    return `${CURRENCY_SYMBOL[money.currency]}${formatted}`;
  },

  /**
   * The amount as an exact decimal string — `15800` KHR becomes `15800`,
   * `1580` USD becomes `15.80`.
   *
   * Built by moving the decimal point through the digits rather than dividing,
   * so no float ever touches the value. For files a person opens in a
   * spreadsheet, where a symbol and thousands separators would get in the way.
   */
  toDecimalString(money: Money): string {
    const scale = CURRENCY_SCALE[money.currency];
    const sign = money.amount < 0 ? '-' : '';
    const digits = Math.abs(money.amount).toString().padStart(scale + 1, '0');

    if (scale === 0) return `${sign}${digits}`;

    return `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  },

  /**
   * Converts between currencies with an explicit rate, returning the rate used
   * so it can be snapshotted alongside the converted amount.
   */
  convert(money: Money, target: Currency, rate: number): { money: Money; rate: number } {
    if (money.currency === target) return { money, rate: 1 };
    const sourceScale = CURRENCY_SCALE[money.currency];
    const targetScale = CURRENCY_SCALE[target];
    const major = money.amount / 10 ** sourceScale;
    const converted = Math.round(major * rate * 10 ** targetScale);
    return { money: { amount: converted, currency: target }, rate };
  },
};
