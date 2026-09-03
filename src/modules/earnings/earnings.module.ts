import { Module } from '@nestjs/common';
import { EarningsController } from './earnings.controller.js';
import { EarningsListener } from './earnings.listener.js';
import { EarningsService } from './earnings.service.js';

@Module({
  controllers: [EarningsController],
  providers: [EarningsService, EarningsListener],
  exports: [EarningsService],
})
export class EarningsModule {}
