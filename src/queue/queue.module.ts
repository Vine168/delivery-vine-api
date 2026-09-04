import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QUEUE } from '../common/constants/queues.js';

/**
 * BullMQ setup.
 *
 * Its connection is deliberately separate from RedisService's: BullMQ manages
 * its own key namespace and does not work behind ioredis' global `keyPrefix`.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: { url: config.getOrThrow<string>('redis.url') },
        prefix: `${config.get<string>('redis.keyPrefix', 'deliver:')}bull`,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: { age: 3_600, count: 1_000 },
          removeOnFail: { age: 24 * 3_600 },
        },
      }),
    }),
    BullModule.registerQueue(
      { name: QUEUE.DELIVERY_MATCHING },
      { name: QUEUE.DELIVERY_TIMEOUT },
      { name: QUEUE.NOTIFICATION },
      { name: QUEUE.MAINTENANCE },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
