import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module.js';
import { WithdrawalsModule } from '../withdrawals/withdrawals.module.js';
import { VehicleTypesModule } from '../vehicle-types/vehicle-types.module.js';
import { DriverDocumentsService } from './driver-documents.service.js';
import { DriverApplicationService } from './driver-application.service.js';
import { DriverProfileService } from './driver-profile.service.js';
import { DriverReadinessService } from './driver-readiness.service.js';
import { DriverVehicleService } from './driver-vehicle.service.js';
import { CustomerDriversController } from './customer-drivers.controller.js';
import { DriversController } from './drivers.controller.js';
import { NearbyDriversService } from './nearby-drivers.service.js';

@Module({
  imports: [VehicleTypesModule, UsersModule, WithdrawalsModule],
  controllers: [DriversController, CustomerDriversController],
  providers: [
    DriverProfileService,
    DriverApplicationService,
    DriverVehicleService,
    DriverDocumentsService,
    DriverReadinessService,
    NearbyDriversService,
  ],
  // DriverReadinessService is exported for the availability endpoint in Phase 4.
  exports: [DriverProfileService, DriverVehicleService, DriverReadinessService],
})
export class DriversModule {}
