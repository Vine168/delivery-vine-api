import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DeliveriesModule } from '../deliveries/deliveries.module.js';
import { DeliveryMatchingModule } from '../delivery-matching/delivery-matching.module.js';
import { DriversModule } from '../drivers/drivers.module.js';
import { UsersModule } from '../users/users.module.js';
import { WalletsModule } from '../wallets/wallets.module.js';
import { WithdrawalsModule } from '../withdrawals/withdrawals.module.js';
import { AdminController } from './controllers/admin.controller.js';
import { AdminDashboardController } from './controllers/admin-dashboard.controller.js';
import { AdminCustomersController } from './controllers/admin-customers.controller.js';
import { AdminDeliveriesController } from './controllers/admin-deliveries.controller.js';
import { AdminDriversController } from './controllers/admin-drivers.controller.js';
import { AdminFinanceController } from './controllers/admin-finance.controller.js';
import { AdminPricingController } from './controllers/admin-pricing.controller.js';
import { AdminPromoCodesController } from './controllers/admin-promo-codes.controller.js';
import { AdminSettingsController } from './controllers/admin-settings.controller.js';
import { AdminZonesController } from './controllers/admin-zones.controller.js';
import { AdminDashboardService } from './services/admin-dashboard.service.js';
import { AdminCustomersService } from './services/admin-customers.service.js';
import { AdminDeliveriesService } from './services/admin-deliveries.service.js';
import { AdminDriversService } from './services/admin-drivers.service.js';
import { AdminCatalogueService } from './services/admin-catalogue.service.js';
import { AdminFinanceService } from './services/admin-finance.service.js';
import { AdminSessionService } from './services/admin-session.service.js';

/**
 * The back office.
 *
 * Access resolution, auditing and the permission guard live in
 * AdminAccessModule, which is global — this module holds the operator-facing
 * endpoints. Nothing here reimplements domain logic: cancelling a delivery
 * goes through the same state machine the mobile apps use, and the operator's
 * wider authority is expressed in the transition policy, not in a bypass.
 */
@Module({
  imports: [
    AuthModule,
    DeliveriesModule,
    DeliveryMatchingModule,
    DriversModule,
    UsersModule,
    WalletsModule,
    WithdrawalsModule,
  ],
  controllers: [
    AdminController,
    AdminDashboardController,
    AdminDeliveriesController,
    AdminDriversController,
    AdminCustomersController,
    AdminFinanceController,
    AdminPricingController,
    AdminZonesController,
    AdminPromoCodesController,
    AdminSettingsController,
  ],
  providers: [
    AdminSessionService,
    AdminDashboardService,
    AdminDeliveriesService,
    AdminDriversService,
    AdminCustomersService,
    AdminFinanceService,
    AdminCatalogueService,
  ],
  exports: [AdminSessionService],
})
export class AdminModule {}
