import { describe, expect, it } from 'vitest';
import { TimeUtil } from './time.util.js';

const PHNOM_PENH = 'Asia/Phnom_Penh';
const NEW_YORK = 'America/New_York';

describe('TimeUtil', () => {
  describe('startOfDay', () => {
    it('returns local midnight as a UTC instant', () => {
      // 09:00 in Phnom Penh on 3 September is 02:00 UTC; the day began at
      // 17:00 UTC the day before.
      const start = TimeUtil.startOfDay(PHNOM_PENH, new Date('2026-09-03T02:00:00Z'));

      expect(start.toISOString()).toBe('2026-09-02T17:00:00.000Z');
    });

    it('puts a late-evening UTC timestamp in the following local day', () => {
      // 23:30 UTC is already 06:30 the next morning in Phnom Penh, so this
      // belongs to the 4th — the mistake a server-local calculation makes.
      const start = TimeUtil.startOfDay(PHNOM_PENH, new Date('2026-09-03T23:30:00Z'));

      expect(TimeUtil.dayKey(PHNOM_PENH, start)).toBe('2026-09-04');
      expect(start.toISOString()).toBe('2026-09-03T17:00:00.000Z');
    });

    it('follows daylight saving where the zone observes it', () => {
      const summer = TimeUtil.startOfDay(NEW_YORK, new Date('2026-07-15T12:00:00Z'));
      const winter = TimeUtil.startOfDay(NEW_YORK, new Date('2026-01-15T12:00:00Z'));

      expect(summer.toISOString()).toBe('2026-07-15T04:00:00.000Z');
      expect(winter.toISOString()).toBe('2026-01-15T05:00:00.000Z');
    });
  });

  describe('endOfDay', () => {
    it('is the start of the next local day', () => {
      const end = TimeUtil.endOfDay(PHNOM_PENH, new Date('2026-09-03T02:00:00Z'));

      expect(end.toISOString()).toBe('2026-09-03T17:00:00.000Z');
    });
  });

  describe('dayKey', () => {
    it('names the local calendar day, not the UTC one', () => {
      expect(TimeUtil.dayKey(PHNOM_PENH, new Date('2026-09-03T18:00:00Z'))).toBe('2026-09-04');
      expect(TimeUtil.dayKey('UTC', new Date('2026-09-03T18:00:00Z'))).toBe('2026-09-03');
    });

    it('pads single-digit months and days', () => {
      expect(TimeUtil.dayKey(PHNOM_PENH, new Date('2026-01-05T06:00:00Z'))).toBe('2026-01-05');
    });
  });

  describe('dayKeysBetween', () => {
    it('covers both ends inclusively', () => {
      const keys = TimeUtil.dayKeysBetween(
        PHNOM_PENH,
        new Date('2026-09-01T03:00:00Z'),
        new Date('2026-09-03T03:00:00Z'),
      );

      expect(keys).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    });

    it('returns a single day when both ends are the same day', () => {
      const same = new Date('2026-09-03T03:00:00Z');

      expect(TimeUtil.dayKeysBetween(PHNOM_PENH, same, same)).toEqual(['2026-09-03']);
    });

    it('does not skip or repeat a day across a daylight-saving change', () => {
      // Clocks go forward in New York on 8 March 2026.
      const keys = TimeUtil.dayKeysBetween(
        NEW_YORK,
        new Date('2026-03-06T17:00:00Z'),
        new Date('2026-03-10T16:00:00Z'),
      );

      expect(keys).toEqual(['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10']);
    });

    it('spans a month boundary', () => {
      const keys = TimeUtil.dayKeysBetween(
        PHNOM_PENH,
        new Date('2026-08-30T03:00:00Z'),
        new Date('2026-09-02T03:00:00Z'),
      );

      expect(keys).toEqual(['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02']);
    });

    it('produces the fourteen days a default dashboard window covers', () => {
      const to = new Date('2026-09-03T03:00:00Z');
      const from = TimeUtil.addDays(TimeUtil.startOfDay(PHNOM_PENH, to), -13);

      expect(TimeUtil.dayKeysBetween(PHNOM_PENH, from, to)).toHaveLength(14);
    });
  });
});
