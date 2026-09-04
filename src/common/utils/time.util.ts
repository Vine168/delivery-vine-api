/**
 * Calendar arithmetic in the platform's reporting timezone.
 *
 * Timestamps are stored and compared in UTC — the database connection is
 * pinned to it deliberately. But a business day is not a UTC day: "revenue
 * today" in Phnom Penh means midnight to midnight local, and computing that
 * with the server's own clock makes the figures depend on where the container
 * happens to run. Everything here takes the zone as an argument, so the answer
 * is the same in every deployment.
 */
export class TimeUtil {
  /** The UTC instant at which the given day begins in `timeZone`. */
  static startOfDay(timeZone: string, at: Date = new Date()): Date {
    const { year, month, day } = TimeUtil.partsIn(timeZone, at);
    const localMidnightAsUtc = Date.UTC(year, month - 1, day);
    return new Date(localMidnightAsUtc - TimeUtil.offsetMs(timeZone, new Date(localMidnightAsUtc)));
  }

  /** The UTC instant at which the given day ends in `timeZone` (exclusive). */
  static endOfDay(timeZone: string, at: Date = new Date()): Date {
    return TimeUtil.addDays(TimeUtil.startOfDay(timeZone, at), 1);
  }

  /** The start of the local day `days` before the local day containing `at`. */
  static startOfDaysAgo(timeZone: string, days: number, at: Date = new Date()): Date {
    return TimeUtil.startOfDay(timeZone, TimeUtil.addDays(at, -days));
  }

  /** `YYYY-MM-DD` as read in `timeZone`. The key a daily chart is bucketed by. */
  static dayKey(timeZone: string, at: Date): string {
    const { year, month, day } = TimeUtil.partsIn(timeZone, at);
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  /** Every `YYYY-MM-DD` from `from` to `to` inclusive, so a chart has no gaps. */
  static dayKeysBetween(timeZone: string, from: Date, to: Date): string[] {
    const keys: string[] = [];
    let cursor = TimeUtil.startOfDay(timeZone, from);
    const last = TimeUtil.startOfDay(timeZone, to);

    while (cursor <= last) {
      keys.push(TimeUtil.dayKey(timeZone, cursor));
      // Step by 25 hours, then re-truncate: a day is not always 24 hours long
      // in zones that observe daylight saving.
      cursor = TimeUtil.startOfDay(timeZone, new Date(cursor.getTime() + 25 * 3_600_000));
    }

    return keys;
  }

  static addDays(at: Date, days: number): Date {
    return new Date(at.getTime() + days * 86_400_000);
  }

  private static partsIn(timeZone: string, at: Date): { year: number; month: number; day: number } {
    const parts = TimeUtil.formatter(timeZone).formatToParts(at);
    const read = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0');
    return { year: read('year'), month: read('month'), day: read('day') };
  }

  /** How far `timeZone` runs ahead of UTC at that instant, in milliseconds. */
  private static offsetMs(timeZone: string, at: Date): number {
    const parts = TimeUtil.formatter(timeZone).formatToParts(at);
    const read = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0');

    const asUtc = Date.UTC(
      read('year'),
      read('month') - 1,
      read('day'),
      // Intl renders midnight as hour 24 in some locales under hourCycle h23.
      read('hour') % 24,
      read('minute'),
      read('second'),
    );

    return asUtc - at.getTime();
  }

  private static formatter(timeZone: string): Intl.DateTimeFormat {
    let cached = TimeUtil.formatters.get(timeZone);
    if (!cached) {
      cached = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      TimeUtil.formatters.set(timeZone, cached);
    }
    return cached;
  }

  private static readonly formatters = new Map<string, Intl.DateTimeFormat>();
}
