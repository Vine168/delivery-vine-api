import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Prisma 7 talks to Postgres through a driver adapter, so the pool is ours to
 * configure. One client per process; Nest owns its lifecycle.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService) {
    const connectionString = config.getOrThrow<string>('database.url');
    const max = config.get<number>('database.poolSize', 10);

    super({
      adapter: new PrismaPg({
        connectionString,
        max,
        // Pin the session to UTC. Without this the connection inherits the
        // server's zone (Asia/Phnom_Penh here), and timestamps written by
        // Prisma no longer line up with `now()` in raw SQL, psql or any BI
        // tool — self-consistent through the ORM, silently off by the offset
        // everywhere else.
        options: '-c timezone=UTC',
      }),
      log:
        config.get<string>('app.env') === 'development'
          ? [{ emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }]
          : [{ emit: 'event', level: 'error' }],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Wipes every table. Test-only: refuses to run outside NODE_ENV=test so a
   * misfired call can never touch a real database.
   */
  async truncateAll(): Promise<void> {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('truncateAll() is only available when NODE_ENV=test');
    }

    const tables = await this.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'
    `;

    const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
    if (list) {
      await this.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    }
  }
}
