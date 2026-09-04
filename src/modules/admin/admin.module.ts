import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DeliveriesModule } from '../deliveries/deliveries.module.js';
import { DeliveryMatchingModule } from '../delivery-matching/delivery-matching.module.js';
import { DriversModule } from '../drivers/drivers.module.js';
import { UsersModule } from '../users/users.module.js';
import { AdminController } from './controllers/admin.controller.js';
import { AdminDashboardController } from './controllers/admin-dashboard.controller.js';
import { AdminCustomersController } from './controllers/admin-customers.controller.js';
import { AdminDeliveriesController } from './controllers/admin-deliveries.controller.js';
import { AdminDriversController } from './controllers/admin-drivers.controller.js';
import { AdminDashboardService } from './services/admin-dashboard.service.js';
import { AdminCustomersService } from './services/admin-customers.service.js';
import { AdminDeliveriesService } from './services/admin-deliveries.service.js';
import { AdminDriversService } from './services/admin-drivers.service.js';
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
  imports: [AuthModule, DeliveriesModule, DeliveryMatchingModule, DriversModule, UsersModule],
  controllers: [
    AdminController,
    AdminDashboardController,
    AdminDeliveriesController,
    AdminDriversController,
    AdminCustomersController,
  ],
  providers: [
    AdminSessionService,
    AdminDashboardService,
    AdminDeliveriesService,
    AdminDriversService,
    AdminCustomersService,
  ],
  exports: [AdminSessionService],
})
export class AdminModule {}
