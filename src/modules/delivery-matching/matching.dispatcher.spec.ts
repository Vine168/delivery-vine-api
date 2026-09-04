import type { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { beforeEach, describe, expect, it } from 'vitest';
import { JOB } from '../../common/constants/queues.js';
import { MatchingDispatcher } from './matching.dispatcher.js';

interface RecordedJob {
  name: string;
  data: Record<string, unknown>;
  options: { jobId?: string; delay?: number };
}

function build(enabled = true): { dispatcher: MatchingDispatcher; jobs: RecordedJob[] } {
  const jobs: RecordedJob[] = [];

  const queue = {
    add: (name: string, data: Record<string, unknown>, options: RecordedJob['options'] = {}) => {
      // BullMQ reserves the colon for its own key namespace and throws on a
      // custom id containing one. Reproduced here so the rule is enforced by
      // the test rather than only discovered at runtime.
      if (options.jobId?.includes(':')) {
        throw new Error('Custom Id cannot contain :');
      }
      jobs.push({ name, data, options });
      return Promise.resolve({ id: options.jobId });
    },
  } as unknown as Queue;

  const config = { get: () => enabled } as unknown as ConfigService;

  return { dispatcher: new MatchingDispatcher(queue, config), jobs };
}

describe('MatchingDispatcher', () => {
  let harness: ReturnType<typeof build>;

  beforeEach(() => {
    harness = build();
  });

  it('never puts a colon in a job id', async () => {
    await harness.dispatcher.startSearch('dlv1', 1_760_000_000_000);
    await harness.dispatcher.scheduleNextRound('dlv1', 2, 30, 1_760_000_000_000);
    await harness.dispatcher.scheduleRoundExpiry('dlv1', 2, 30, 1_760_000_000_000);

    expect(harness.jobs).toHaveLength(3);
    for (const job of harness.jobs) {
      expect(job.options.jobId).toBeTruthy();
      expect(job.options.jobId).not.toContain(':');
    }
  });

  describe('search attempts', () => {
    it('gives each search attempt its own job ids', async () => {
      // The same delivery, searched twice — a driver handed it back, or an
      // operator reassigned it.
      await harness.dispatcher.startSearch('dlv1', 1_000);
      await harness.dispatcher.startSearch('dlv1', 2_000);

      const [first, second] = harness.jobs.map((job) => job.options.jobId);
      expect(first).not.toBe(second);
    });

    it('reuses the id within one attempt, so a repeated event dispatches once', async () => {
      await harness.dispatcher.startSearch('dlv1', 1_000);
      await harness.dispatcher.startSearch('dlv1', 1_000);

      const ids = new Set(harness.jobs.map((job) => job.options.jobId));
      expect(ids.size).toBe(1);
    });

    it('carries the attempt through the round chain', async () => {
      await harness.dispatcher.startSearch('dlv1', 1_000);
      await harness.dispatcher.scheduleNextRound('dlv1', 2, 30, 1_000);

      expect(harness.jobs.map((job) => job.data)).toEqual([
        { deliveryId: 'dlv1', round: 1, search: 1_000 },
        { deliveryId: 'dlv1', round: 2, search: 1_000 },
      ]);
    });

    it('keeps a round and its expiry apart', async () => {
      await harness.dispatcher.scheduleNextRound('dlv1', 2, 30, 1_000);
      await harness.dispatcher.scheduleRoundExpiry('dlv1', 2, 30, 1_000);

      expect(harness.jobs[0].name).toBe(JOB.DISPATCH_ROUND);
      expect(harness.jobs[1].name).toBe(JOB.EXPIRE_OFFER);
      expect(harness.jobs[0].options.jobId).not.toBe(harness.jobs[1].options.jobId);
    });
  });

  it('dispatches nothing when matching is switched off', async () => {
    const disabled = build(false);

    await disabled.dispatcher.startSearch('dlv1', 1_000);
    await disabled.dispatcher.scheduleNextRound('dlv1', 2, 30, 1_000);
    await disabled.dispatcher.scheduleRoundExpiry('dlv1', 2, 30, 1_000);

    expect(disabled.jobs).toEqual([]);
  });

  it('delays a scheduled round by the window it was given', async () => {
    await harness.dispatcher.scheduleNextRound('dlv1', 3, 45, 1_000);

    expect(harness.jobs[0].options.delay).toBe(45_000);
  });
});
