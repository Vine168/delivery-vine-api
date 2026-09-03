import { Module } from '@nestjs/common';
import { VehicleTypesModule } from '../vehicle-types/vehicle-types.module.js';
import { DriverDocumentsService } from './driver-documents.service.js';
import { DriverProfileService } from './driver-profile.service.js';
import { DriverReadinessService } from './driver-readiness.service.js';
import { DriverVehicleService } from './driver-vehicle.service.js';
import { DriversController } from './drivers.controller.js';

@Module({
  imports: [VehicleTypesModule],
  controllers: [DriversController],
  providers: [DriverProfileService, DriverVehicleService, DriverDocumentsService, DriverReadinessService],
  // DriverReadinessService is exported for the availability endpoint in Phase 4.
  exports: [DriverProfileService, DriverVehicleService, DriverReadinessService],
})
export class DriversModule {}
