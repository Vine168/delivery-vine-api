import { describe, expect, it } from 'vitest';
import { PhoneUtil } from './phone.util.js';

describe('PhoneUtil', () => {
  it('normalises every local format to the same E.164 value', () => {
    const expected = '+85512345678';
    for (const input of ['012345678', '0 12 345 678', '+855 12 345 678', '85512345678', '(012) 345-678']) {
      expect(PhoneUtil.normalise(input)).toBe(expected);
    }
  });

  it('is idempotent', () => {
    const once = PhoneUtil.normalise('012345678');
    expect(PhoneUtil.normalise(once)).toBe(once);
  });

  it('validates length', () => {
    expect(PhoneUtil.isValid('012345678')).toBe(true);
    expect(PhoneUtil.isValid('12')).toBe(false);
  });

  it('masks the middle for display to the other party', () => {
    expect(PhoneUtil.mask('+85512345678')).toBe('+85512***678');
  });
});
