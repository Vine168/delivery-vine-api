import { Module } from '@nestjs/common';
import { DeliveriesModule } from '../deliveries/deliveries.module.js';
import { DeliveryMatchingModule } from '../delivery-matching/delivery-matching.module.js';
import { DriverJobsController } from './driver-jobs.controller.js';
import { DriverJobsService } from './driver-jobs.service.js';

@Module({
  imports: [DeliveriesModule, DeliveryMatchingModule],
  controllers: [DriverJobsController],
  providers: [DriverJobsService],
  exports: [DriverJobsService],
})
export class DriverJobsModule {}
