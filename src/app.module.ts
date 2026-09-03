import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { LoggerModule } from 'nestjs-pino';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard.js';
import { RateLimitGuard } from './common/guards/rate-limit.guard.js';
import { RolesGuard } from './common/guards/roles.guard.js';
import { ResponseInterceptor } from './common/interceptors/response.interceptor.js';
import { buildLoggerOptions } from './common/logger/logger.config.js';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware.js';
import { AppConfigModule } from './config/config.module.js';
import { PrismaModule } from './database/prisma.module.js';
import { RedisModule } from './redis/redis.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { UsersModule } from './modules/users/users.module.js';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        buildLoggerOptions(config.get<string>('app.env') === 'development', config.get<string>('app.logLevel', 'info')),
    }),
    EventEmitterModule.forRoot({ wildcard: false, delimiter: '.', maxListeners: 20, verboseMemoryLeak: true }),
    PrismaModule,
    RedisModule,
    UsersModule,
    AuthModule,
    HealthModule,
  ],
  providers: [
    // Order matters: authenticate, then authorise, then meter. Metering last
    // means `@RateLimit({ by: 'user' })` can see who is calling.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*splat');
  }
}
