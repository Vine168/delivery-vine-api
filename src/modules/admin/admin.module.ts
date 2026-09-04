import { Module } from '@nestjs/common';
import { DeliveriesModule } from '../deliveries/deliveries.module.js';
import { DeliveryMatchingModule } from '../delivery-matching/delivery-matching.module.js';
import { AdminController } from './controllers/admin.controller.js';
import { AdminDashboardController } from './controllers/admin-dashboard.controller.js';
import { AdminDeliveriesController } from './controllers/admin-deliveries.controller.js';
import { AdminDashboardService } from './services/admin-dashboard.service.js';
import { AdminDeliveriesService } from './services/admin-deliveries.service.js';
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
  imports: [DeliveriesModule, DeliveryMatchingModule],
  controllers: [AdminController, AdminDashboardController, AdminDeliveriesController],
  providers: [AdminSessionService, AdminDashboardService, AdminDeliveriesService],
  exports: [AdminSessionService],
})
export class AdminModule {}
