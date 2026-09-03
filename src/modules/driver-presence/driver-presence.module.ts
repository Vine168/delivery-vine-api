import { Global, Module } from '@nestjs/common';
import { DriversModule } from '../drivers/drivers.module.js';
import { DriverAvailabilityController } from './driver-availability.controller.js';
import { DriverAvailabilityService } from './driver-availability.service.js';
import { DriverDashboardService } from './driver-dashboard.service.js';
import { DriverPresenceService } from './driver-presence.service.js';

/**
 * Global because matching, tracking and the customer's nearby-drivers screen
 * all read presence.
 */
@Global()
@Module({
  imports: [DriversModule],
  controllers: [DriverAvailabilityController],
  providers: [DriverPresenceService, DriverAvailabilityService, DriverDashboardService],
  exports: [DriverPresenceService, DriverAvailabilityService],
})
export class DriverPresenceModule {}
