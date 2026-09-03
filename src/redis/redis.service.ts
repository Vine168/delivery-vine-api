import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis, type RedisOptions } from 'ioredis';

/**
 * Owns the application's Redis connections.
 *
 * Redis is used for volatile, high-churn state — OTPs, driver presence and the
 * live GEO index, matching locks, rate-limit counters and the map cache.
 * Postgres remains the source of truth for anything a customer could dispute.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly options: RedisOptions;
  readonly client: Redis;
  private readonly extraClients: Redis[] = [];

  constructor(private readonly config: ConfigService) {
    const url = this.config.getOrThrow<string>('redis.url');
    this.options = {
      keyPrefix: this.config.get<string>('redis.keyPrefix', 'deliver:'),
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: true,
      retryStrategy: (times) => Math.min(times * 200, 5000),
    };
    this.client = new Redis(url, this.options);
  }

  async onModuleInit(): Promise<void> {
    this.client.on('error', (error: Error) => this.logger.error(`Redis error: ${error.message}`));
    await this.client.connect();
    this.logger.log('Redis connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.client.quit(), ...this.extraClients.map((c) => c.quit())]);
  }

  /**
   * A dedicated connection. Pub/sub and the Socket.IO adapter need their own
   * sockets, and BullMQ requires a connection without a key prefix.
   *
   * `managed: false` hands the caller responsibility for closing it. The
   * Socket.IO adapter needs that: it still talks to Redis while the server
   * shuts down, and module teardown order does not guarantee this service
   * outlives the gateway.
   */
  duplicate(overrides: Partial<RedisOptions> = {}, options: { managed?: boolean } = {}): Redis {
    const client = this.client.duplicate(overrides);
    if (options.managed !== false) {
      this.extraClients.push(client);
    }
    return client;
  }

  // ── Small helpers used across modules ──────────────────────────────────

  async setJson(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const payload = JSON.stringify(value);
    if (ttlSeconds) {
      await this.client.set(key, payload, 'EX', ttlSeconds);
    } else {
      await this.client.set(key, payload);
    }
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      await this.client.del(key);
      return null;
    }
  }

  /**
   * Best-effort distributed lock. Returns a release function, or null when the
   * lock is already held. Callers must treat "not acquired" as a real outcome —
   * the database constraints remain the final guarantee.
   */
  async acquireLock(key: string, ttlSeconds: number): Promise<(() => Promise<void>) | null> {
    const token = `${process.pid}:${Date.now()}:${Math.random()}`;
    const acquired = await this.client.set(key, token, 'EX', ttlSeconds, 'NX');
    if (!acquired) return null;

    return async () => {
      // Only release a lock we still own.
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end`;
      await this.client.eval(script, 1, key, token);
    };
  }

  /**
   * Fixed-window counter. Returns the count after increment so callers can
   * decide between "allowed" and "rate limited" in a single round trip.
   */
  async incrementWithTtl(key: string, ttlSeconds: number): Promise<number> {
    const results = await this.client.multi().incr(key).expire(key, ttlSeconds, 'NX').exec();
    const count = results?.[0]?.[1];
    return typeof count === 'number' ? count : Number(count ?? 0);
  }

  async ttl(key: string): Promise<number> {
    return this.client.ttl(key);
  }
}
