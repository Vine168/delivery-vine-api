import { Module } from '@nestjs/common';
import { EarningsModule } from '../earnings/earnings.module.js';
import { MaintenanceProcessor } from './maintenance.processor.js';
import { MaintenanceService } from './maintenance.service.js';
import { OrphanedFilesService } from './orphaned-files.service.js';

/**
 * The worker follows the same rule as the others: a BullMQ worker holds a
 * blocking Redis connection permanently, so an instance that will never run
 * the schedule — a test run — should not start one. The service itself is
 * always available, so a sweep can be triggered directly.
 */
const worker = process.env.MATCHING_ENABLED === 'false' ? [] : [MaintenanceProcessor];

@Module({
  imports: [EarningsModule],
  providers: [MaintenanceService, OrphanedFilesService, ...worker],
  exports: [MaintenanceService, OrphanedFilesService],
})
export class MaintenanceModule {}
