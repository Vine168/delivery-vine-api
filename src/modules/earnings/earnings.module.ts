import { Module } from '@nestjs/common';
import { EarningsController } from './earnings.controller.js';
import { EarningsListener } from './earnings.listener.js';
import { EarningsReconciliationService } from './earnings-reconciliation.service.js';
import { EarningsService } from './earnings.service.js';

@Module({
  controllers: [EarningsController],
  providers: [EarningsService, EarningsListener, EarningsReconciliationService],
  exports: [EarningsService, EarningsReconciliationService],
})
export class EarningsModule {}
