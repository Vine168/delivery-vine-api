import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { LoggerModule } from 'nestjs-pino';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard.js';
import { RateLimitGuard } from './common/guards/rate-limit.guard.js';
import { RolesGuard } from './common/guards/roles.guard.js';
import { PermissionsGuard } from './modules/admin/permissions.guard.js';
import { ResponseInterceptor } from './common/interceptors/response.interceptor.js';
import { buildLoggerOptions } from './common/logger/logger.config.js';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware.js';
import { AppConfigModule } from './config/config.module.js';
import { PrismaModule } from './database/prisma.module.js';
import { RealtimeModule } from './gateway/realtime.module.js';
import { QueueModule } from './queue/queue.module.js';
import { RedisModule } from './redis/redis.module.js';
import { SettingsModule } from './modules/settings/settings.module.js';
import { AddressesModule } from './modules/addresses/addresses.module.js';
import { AdminAccessModule } from './modules/admin/admin-access.module.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { ChatModule } from './modules/chat/chat.module.js';
import { CustomersModule } from './modules/customers/customers.module.js';
import { FavoriteDriversModule } from './modules/favorite-drivers/favorite-drivers.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { PackageTemplatesModule } from './modules/package-templates/package-templates.module.js';
import { RatingsModule } from './modules/ratings/ratings.module.js';
import { DeliveriesModule } from './modules/deliveries/deliveries.module.js';
import { DeliveryMatchingModule } from './modules/delivery-matching/delivery-matching.module.js';
import { DriverJobsModule } from './modules/driver-jobs/driver-jobs.module.js';
import { DriverPresenceModule } from './modules/driver-presence/driver-presence.module.js';
import { EarningsModule } from './modules/earnings/earnings.module.js';
import { DriversModule } from './modules/drivers/drivers.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { LocationsModule } from './modules/locations/locations.module.js';
import { MaintenanceModule } from './modules/maintenance/maintenance.module.js';
import { PricingModule } from './modules/pricing/pricing.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { PromoCodesModule } from './modules/promo-codes/promo-codes.module.js';
import { WalletsModule } from './modules/wallets/wallets.module.js';
import { WithdrawalsModule } from './modules/withdrawals/withdrawals.module.js';
import { StorageModule } from './modules/storage/storage.module.js';
import { UploadsModule } from './modules/uploads/uploads.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { VehicleTypesModule } from './modules/vehicle-types/vehicle-types.module.js';

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
    QueueModule,
    SettingsModule,
    StorageModule,
    UploadsModule,
    UsersModule,
    AdminAccessModule,
    AuthModule,
    AdminModule,
    CustomersModule,
    AddressesModule,
    DriversModule,
    VehicleTypesModule,
    LocationsModule,
    PricingModule,
    PromoCodesModule,
    DeliveriesModule,
    DriverPresenceModule,
    DeliveryMatchingModule,
    DriverJobsModule,
    WalletsModule,
    EarningsModule,
    WithdrawalsModule,
    PaymentsModule,
    RatingsModule,
    FavoriteDriversModule,
    PackageTemplatesModule,
    ChatModule,
    NotificationsModule,
    RealtimeModule,
    MaintenanceModule,
    HealthModule,
  ],
  providers: [
    // Order matters: authenticate, then authorise, then meter. Metering last
    // means `@RateLimit({ by: 'user' })` can see who is calling.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    // After RolesGuard: the role gate decides you are an operator, this decides
    // which operator actions you may take.
    { provide: APP_GUARD, useClass: PermissionsGuard },
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
