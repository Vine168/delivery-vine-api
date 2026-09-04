import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { JOB, QUEUE } from '../../../common/constants/queues.js';
import { AdminNotificationsService, type CampaignJob } from './admin-notifications.service.js';

/**
 * Runs a campaign off the request path.
 *
 * A thin adapter, like the matching processor: the sending itself lives in the
 * service, so it can be driven directly by a test or a replay without a queue
 * in the way.
 */
@Processor(QUEUE.NOTIFICATION)
export class CampaignProcessor extends WorkerHost {
  private readonly logger = new Logger(CampaignProcessor.name);

  constructor(private readonly campaigns: AdminNotificationsService) {
    super();
  }

  async process(job: Job<CampaignJob>): Promise<void> {
    if (job.name !== JOB.SEND_CAMPAIGN) return;

    await this.campaigns.deliver(job.data.campaignId);
  }
}
