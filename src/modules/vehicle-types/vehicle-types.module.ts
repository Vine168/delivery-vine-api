import { Module } from '@nestjs/common';
import { VehicleTypesController } from './vehicle-types.controller.js';
import { VehicleTypesService } from './vehicle-types.service.js';

@Module({
  controllers: [VehicleTypesController],
  providers: [VehicleTypesService],
  exports: [VehicleTypesService],
})
export class VehicleTypesModule {}
