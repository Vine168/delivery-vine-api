import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Queue, type Job } from 'bullmq';
import { JOB, QUEUE } from '../../common/constants/queues.js';
import { EarningsReconciliationService } from '../earnings/earnings-reconciliation.service.js';
import { MaintenanceService } from './maintenance.service.js';
import { OrphanedFilesService } from './orphaned-files.service.js';

/**
 * The schedule.
 *
 * Reconciliation runs often because it is cheap and it is the safety net under
 * driver pay; the prunes run nightly, off the hour, because they touch tables
 * the live paths write to.
 */
const SCHEDULE: { name: string; pattern: string }[] = [
  { name: JOB.RECONCILE_EARNINGS, pattern: '*/15 * * * *' },
  { name: JOB.PRUNE_TRACK_POINTS, pattern: '17 3 * * *' },
  { name: JOB.PRUNE_IDEMPOTENCY_KEYS, pattern: '32 3 * * *' },
  { name: JOB.PRUNE_OTP_RECORDS, pattern: '47 3 * * *' },
  { name: JOB.PRUNE_AUTH_RECORDS, pattern: '2 4 * * *' },
  // Weekly, and last: it talks to object storage, which is slower and
  // costlier per call than anything else here.
  { name: JOB.PRUNE_ORPHANED_FILES, pattern: '22 4 * * 0' },
];

/**
 * Scheduled housekeeping.
 *
 * Repeatable BullMQ jobs rather than in-process timers: they survive a restart,
 * and several API instances share one schedule instead of each running their
 * own copy of every sweep.
 */
@Injectable()
@Processor(QUEUE.MAINTENANCE)
export class MaintenanceProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(MaintenanceProcessor.name);

  constructor(
    @InjectQueue(QUEUE.MAINTENANCE) private readonly queue: Queue,
    private readonly maintenance: MaintenanceService,
    private readonly orphanedFiles: OrphanedFilesService,
    private readonly reconciliation: EarningsReconciliationService,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    for (const entry of SCHEDULE) {
      // Upsert by a fixed scheduler id, so restarting instances converge on
      // one schedule instead of stacking duplicates of it — and changing a
      // pattern here replaces the old one rather than running both.
      await this.queue.upsertJobScheduler(
        `maintenance-${entry.name}`,
        { pattern: entry.pattern },
        { name: entry.name, data: {} },
      );
    }

    this.logger.log(`Scheduled ${SCHEDULE.length} maintenance job(s)`);
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case JOB.RECONCILE_EARNINGS:
        await this.reconciliation.sweep();
        break;
      case JOB.PRUNE_TRACK_POINTS:
        await this.maintenance.pruneTrackPoints();
        break;
      case JOB.PRUNE_IDEMPOTENCY_KEYS:
        await this.maintenance.pruneIdempotencyKeys();
        break;
      case JOB.PRUNE_OTP_RECORDS:
        await this.maintenance.pruneOtpVerifications();
        break;
      case JOB.PRUNE_AUTH_RECORDS:
        // Tokens before sessions: a session cannot go while its tokens
        // reference it.
        await this.maintenance.pruneRefreshTokens();
        await this.maintenance.pruneSessions();
        await this.maintenance.prunePushDispatches();
        break;
      case JOB.PRUNE_ORPHANED_FILES:
        await this.orphanedFiles.sweep();
        break;
      default:
        this.logger.warn(`Unknown maintenance job: ${job.name}`);
    }
  }
}
