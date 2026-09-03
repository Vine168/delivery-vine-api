import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisKey } from '../../common/constants/redis-keys.js';
import { PrismaService } from '../../database/prisma.service.js';
import { RedisService } from '../../redis/redis.service.js';

const SEQUENCE_PADDING = 5;

/**
 * Generates the public booking code: `ORD-20260903-00128`.
 *
 * Separate from the primary key on purpose — customers read this out over the
 * phone, and it must never be something the system depends on for identity.
 * The daily sequence lives in Redis for speed; the unique constraint on the
 * column is what actually guarantees uniqueness, so a Redis restart is
 * survivable rather than catastrophic.
 */
@Injectable()
export class BookingCodeService {
  private readonly logger = new Logger(BookingCodeService.name);
  private readonly prefix: string;

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.prefix = config.get<string>('app.bookingCodePrefix', 'ORD');
  }

  async next(now = new Date()): Promise<string> {
    const day = this.formatDay(now);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const sequence = await this.nextSequence(day, attempt);
      const code = `${this.prefix}-${day}-${String(sequence).padStart(SEQUENCE_PADDING, '0')}`;

      const clash = await this.prisma.delivery.findUnique({ where: { bookingCode: code }, select: { id: true } });
      if (!clash) return code;

      this.logger.warn(`Booking code ${code} was already taken; retrying`);
    }

    // Redis is out of step with the database. Fall back to something that
    // cannot collide rather than failing the customer's booking.
    return `${this.prefix}-${day}-${Date.now().toString(36).toUpperCase()}`;
  }

  private async nextSequence(day: string, attempt: number): Promise<number> {
    const key = RedisKey.bookingCodeSequence(day);

    try {
      const value = await this.redis.client.incr(key);
      if (value === 1) {
        // Keep the counter a little past midnight for late-arriving requests.
        await this.redis.client.expire(key, 36 * 3_600);
      }
      return value + attempt;
    } catch (error) {
      this.logger.warn(`Redis sequence unavailable, counting from the database: ${String(error)}`);
      const startOfDay = new Date(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T00:00:00.000Z`);
      const count = await this.prisma.delivery.count({ where: { createdAt: { gte: startOfDay } } });
      return count + 1 + attempt;
    }
  }

  private formatDay(date: Date): string {
    return date.toISOString().slice(0, 10).replaceAll('-', '');
  }
}
