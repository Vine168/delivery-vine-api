/**
 * Cambodian phone numbers arrive from the apps in several shapes
 * (`012345678`, `+85512345678`, `85512345678`). We normalise to E.164 once, at
 * the edge, so `User.phone` has exactly one representation and lookups cannot
 * miss.
 */
const DEFAULT_COUNTRY_CODE = '855';

export const PhoneUtil = {
  normalise(input: string, countryCode = DEFAULT_COUNTRY_CODE): string {
    const digits = input.replace(/[^\d+]/g, '').replace(/^\+/, '');

    if (digits.startsWith(countryCode)) {
      return `+${digits}`;
    }
    if (digits.startsWith('0')) {
      return `+${countryCode}${digits.slice(1)}`;
    }
    return `+${countryCode}${digits}`;
  },

  isValid(input: string): boolean {
    return /^\+\d{8,15}$/.test(PhoneUtil.normalise(input));
  },

  /** `+85512345678` → `+855 12 *** 678` for display in another party's app. */
  mask(phone: string): string {
    if (phone.length < 6) return '***';
    return `${phone.slice(0, -6)}***${phone.slice(-3)}`;
  },
};
