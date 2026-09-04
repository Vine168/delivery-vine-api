import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './app-harness.js';
import {
  API,
  activate,
  adminAccount,
  http,
  nextPhone,
  readyDriver,
  type ActivatedAccount,
  type AdminAccount,
} from './helpers.js';

const NEARBY = { latitude: 11.557, longitude: 104.929 };

const COMMS_OPS = ['admin.access', 'notifications.view', 'notifications.send', 'zones.manage', 'drivers.edit'];

describe('Back office — notifications (e2e)', () => {
  let harness: TestHarness;
  let admin: AdminAccount;

  beforeAll(async () => {
    harness = await createTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
    harness.map.shouldFail = false;
    admin = await adminAccount(harness, COMMS_OPS);
  });

  const asAdmin = () => ({ Authorization: `Bearer ${admin.accessToken}` });

  /** Queues a campaign and runs the worker's job inline. */
  async function sendAndDeliver(body: Record<string, unknown>): Promise<string> {
    const queued = await http(harness).post(`${API}/admin/notifications`).set(asAdmin()).send(body).expect(201);

    expect(queued.body.data.status).toBe('QUEUED');
    await harness.campaigns.deliver(queued.body.data.id);
    return queued.body.data.id;
  }

  // ── Audience ───────────────────────────────────────────────────────────

  describe('audience', () => {
    it('counts recipients before anything is sent', async () => {
      await activate(harness);
      await activate(harness);
      await readyDriver(harness, NEARBY);

      const customers = await http(harness)
        .post(`${API}/admin/notifications/audience-preview`)
        .set(asAdmin())
        .send({ audience: 'ALL_CUSTOMERS' })
        .expect(200);

      expect(customers.body.data).toMatchObject({
        audience: 'ALL_CUSTOMERS',
        recipientCount: 2,
        reachableByPush: 0,
      });

      const drivers = await http(harness)
        .post(`${API}/admin/notifications/audience-preview`)
        .set(asAdmin())
        .send({ audience: 'ALL_DRIVERS' })
        .expect(200);
      expect(drivers.body.data.recipientCount).toBe(1);

      // Nothing was written by asking.
      expect(await harness.prisma.notification.count()).toBe(0);
      expect(await harness.prisma.notificationCampaign.count()).toBe(0);
    });

    it('excludes suspended accounts', async () => {
      const customer = await activate(harness);
      await activate(harness);

      await harness.prisma.user.update({
        where: { id: customer.userId },
        data: { status: 'SUSPENDED', suspendedReason: 'Fraud' },
      });

      const response = await http(harness)
        .post(`${API}/admin/notifications/audience-preview`)
        .set(asAdmin())
        .send({ audience: 'ALL_CUSTOMERS' })
        .expect(200);

      expect(response.body.data.recipientCount).toBe(1);
    });

    it('reaches only the drivers who are online', async () => {
      const working = await readyDriver(harness, NEARBY);
      const offDuty = await readyDriver(harness, NEARBY);

      await http(harness)
        .put(`${API}/mobile/driver/availability`)
        .set({ Authorization: `Bearer ${offDuty.accessToken}` })
        .send({ status: 'OFFLINE' })
        .expect(200);

      const preview = await http(harness)
        .post(`${API}/admin/notifications/audience-preview`)
        .set(asAdmin())
        .send({ audience: 'ONLINE_DRIVERS' })
        .expect(200);
      expect(preview.body.data.recipientCount).toBe(1);

      await sendAndDeliver({
        audience: 'ONLINE_DRIVERS',
        title: 'Rain warning',
        body: 'Heavy rain in Phnom Penh — take care out there.',
      });

      const notified = await harness.prisma.notification.findMany({ select: { userId: true } });
      expect(notified.map((row) => row.userId)).toEqual([working.userId]);
    });

    it('reaches only the drivers assigned to a zone', async () => {
      const inZone = await readyDriver(harness, NEARBY);
      await readyDriver(harness, NEARBY);

      const zone = await http(harness)
        .post(`${API}/admin/zones`)
        .set(asAdmin())
        .send({
          code: 'PP-CENTRAL',
          name: 'Central',
          coverageType: 'RADIUS',
          centerLatitude: 11.5564,
          centerLongitude: 104.9282,
          radiusMeters: 8_000,
        })
        .expect(201);

      await http(harness)
        .put(`${API}/admin/drivers/${inZone.driverId}/zones`)
        .set(asAdmin())
        .send({ zoneIds: [zone.body.data.id] })
        .expect(200);

      await sendAndDeliver({
        audience: 'DRIVERS_IN_ZONE',
        zoneId: zone.body.data.id,
        title: 'Road works',
        body: 'Norodom Blvd is closed until Friday.',
      });

      const notified = await harness.prisma.notification.findMany({ select: { userId: true } });
      expect(notified.map((row) => row.userId)).toEqual([inZone.userId]);
    });

    it('refuses a zone that does not exist, before writing a campaign', async () => {
      const response = await http(harness)
        .post(`${API}/admin/notifications`)
        .set(asAdmin())
        .send({
          audience: 'DRIVERS_IN_ZONE',
          zoneId: 'zk0078hwg1a85xjjo4k626h0',
          title: 'Nowhere',
          body: 'Nobody',
        })
        .expect(404);

      expect(response.body.code).toBe('ZONE_NOT_FOUND');
      expect(await harness.prisma.notificationCampaign.count()).toBe(0);
    });

    it('requires the parts the chosen audience needs', async () => {
      const missingZone = await http(harness)
        .post(`${API}/admin/notifications`)
        .set(asAdmin())
        .send({ audience: 'DRIVERS_IN_ZONE', title: 'A', body: 'B' })
        .expect(400);
      expect(missingZone.body.code).toBe('VALIDATION_ERROR');

      const missingUsers = await http(harness)
        .post(`${API}/admin/notifications`)
        .set(asAdmin())
        .send({ audience: 'SPECIFIC_USERS', title: 'A', body: 'B' })
        .expect(400);
      expect(missingUsers.body.code).toBe('VALIDATION_ERROR');
    });
  });

  // ── Sending ────────────────────────────────────────────────────────────

  describe('sending', () => {
    it('returns immediately and delivers in the background', async () => {
      const one = await activate(harness);
      const two = await activate(harness);

      const queued = await http(harness)
        .post(`${API}/admin/notifications`)
        .set(asAdmin())
        .send({
          audience: 'ALL_CUSTOMERS',
          title: 'Service update',
          body: 'Deliveries may be slower this evening.',
          data: { screen: 'promotions' },
        })
        .expect(201);

      // Nothing has gone out yet — the request did not wait for it.
      expect(queued.body.data).toMatchObject({
        status: 'QUEUED',
        totalRecipients: 0,
        sentCount: 0,
        createdByName: 'Ops Operator',
      });
      expect(await harness.prisma.notification.count()).toBe(0);

      await harness.campaigns.deliver(queued.body.data.id);

      const finished = await http(harness)
        .get(`${API}/admin/notifications/${queued.body.data.id}`)
        .set(asAdmin())
        .expect(200);

      expect(finished.body.data).toMatchObject({
        status: 'COMPLETED',
        totalRecipients: 2,
        sentCount: 2,
        failedCount: 0,
      });
      expect(finished.body.data.startedAt).toBeTruthy();
      expect(finished.body.data.completedAt).toBeTruthy();

      const notifications = await harness.prisma.notification.findMany({ orderBy: { createdAt: 'asc' } });
      expect(notifications.map((row) => row.userId).sort()).toEqual([one.userId, two.userId].sort());
      expect(notifications[0].title).toBe('Service update');
      expect(notifications[0].data).toMatchObject({
        campaignId: queued.body.data.id,
        screen: 'promotions',
      });
    });

    it('reaches named people and nobody else', async () => {
      const chosen = await activate(harness);
      const bystander = await activate(harness);

      await sendAndDeliver({
        audience: 'SPECIFIC_USERS',
        userIds: [chosen.userId],
        title: 'About your delivery',
        body: 'Support has refunded your last booking.',
        type: 'SYSTEM_ANNOUNCEMENT',
      });

      const notified = await harness.prisma.notification.findMany({ select: { userId: true } });
      expect(notified.map((row) => row.userId)).toEqual([chosen.userId]);
      expect(notified.map((row) => row.userId)).not.toContain(bystander.userId);
    });

    it('lands in the recipient’s own notification list', async () => {
      const customer = await activate(harness);

      await sendAndDeliver({
        audience: 'ALL_CUSTOMERS',
        title: 'Ten percent off',
        body: 'Use SAVE500 before Friday.',
        type: 'PROMOTION',
      });

      const inbox = await http(harness)
        .get(`${API}/mobile/notifications`)
        .set({ Authorization: `Bearer ${customer.accessToken}` })
        .expect(200);

      expect(inbox.body.data).toHaveLength(1);
      expect(inbox.body.data[0]).toMatchObject({ title: 'Ten percent off', type: 'PROMOTION', read: false });

      const unread = await http(harness)
        .get(`${API}/mobile/notifications/unread-count`)
        .set({ Authorization: `Bearer ${customer.accessToken}` })
        .expect(200);
      expect(unread.body.data.unread).toBe(1);
    });

    it('does not send twice if the job runs again', async () => {
      await activate(harness);

      const campaignId = await sendAndDeliver({
        audience: 'ALL_CUSTOMERS',
        title: 'Once only',
        body: 'This should arrive one time.',
      });

      // A retried job, a duplicated event, a manual replay — all the same.
      await harness.campaigns.deliver(campaignId);
      await harness.campaigns.deliver(campaignId);

      expect(await harness.prisma.notification.count()).toBe(1);

      const campaign = await harness.prisma.notificationCampaign.findUniqueOrThrow({
        where: { id: campaignId },
      });
      expect(campaign.sentCount).toBe(1);
    });
  });

  // ── History ────────────────────────────────────────────────────────────

  describe('history', () => {
    it('lists campaigns with how far each got', async () => {
      await activate(harness);
      await sendAndDeliver({ audience: 'ALL_CUSTOMERS', title: 'First', body: 'One' });
      await sendAndDeliver({ audience: 'ALL_DRIVERS', title: 'Second', body: 'Two' });

      const response = await http(harness).get(`${API}/admin/notifications`).set(asAdmin()).expect(200);

      expect(response.body.data).toHaveLength(2);
      expect(response.body.data[0].title).toBe('Second');
      expect(response.body.data[0]).toMatchObject({ status: 'COMPLETED', totalRecipients: 0, sentCount: 0 });
      expect(response.body.data[1]).toMatchObject({ status: 'COMPLETED', totalRecipients: 1, sentCount: 1 });

      const filtered = await http(harness)
        .get(`${API}/admin/notifications?audience=ALL_DRIVERS`)
        .set(asAdmin())
        .expect(200);
      expect(filtered.body.data).toHaveLength(1);
    });

    it('shows what an individual was told, and whether a push was attempted', async () => {
      const customer = await activate(harness);
      await sendAndDeliver({ audience: 'ALL_CUSTOMERS', title: 'Told you', body: 'Something happened.' });

      const response = await http(harness)
        .get(`${API}/admin/notifications/history?userId=${customer.userId}`)
        .set(asAdmin())
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0]).toMatchObject({
        recipientName: 'Sok Dara',
        recipientPhone: customer.phone.replace(/^0/, '+855'),
        title: 'Told you',
        readAt: null,
        // No device registered, so no push was attempted — which is not a
        // failure.
        pushStatus: 'NONE',
      });
    });

    it('includes the automatic delivery notifications, not only campaigns', async () => {
      const customer = await activate(harness);
      const driver = await readyDriver(harness, NEARBY);
      const vehicleTypeId = (await harness.prisma.vehicleType.findFirstOrThrow({ select: { id: true } })).id;

      const booking = await http(harness)
        .post(`${API}/mobile/customer/deliveries`)
        .set({ Authorization: `Bearer ${customer.accessToken}` })
        .send({
          pickup: {
            address: 'Independence Monument',
            latitude: 11.5564,
            longitude: 104.9282,
            contactName: 'Sok Dara',
            contactPhone: '012345678',
          },
          dropoff: {
            address: 'Chak Angrae',
            latitude: 11.5,
            longitude: 104.87,
            contactName: 'Chan Vuthy',
            contactPhone: '012999888',
          },
          vehicleTypeId,
          currency: 'KHR',
          packages: [{ size: 'SMALL', weightKg: 2 }],
          paymentMethod: 'CASH_ON_DELIVERY',
        })
        .expect(201);

      await harness.matching.runRound(booking.body.data.id, 1);
      await http(harness)
        .post(`${API}/mobile/driver/jobs/${booking.body.data.id}/accept`)
        .set({ Authorization: `Bearer ${driver.accessToken}` })
        .expect(200);

      const response = await http(harness)
        .get(`${API}/admin/notifications/history?type=DRIVER_ASSIGNED`)
        .set(asAdmin())
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].userId).toBe(customer.userId);
    });
  });

  // ── Cancelling ─────────────────────────────────────────────────────────

  describe('cancelling', () => {
    it('stops a queued message before it goes out', async () => {
      await activate(harness);

      const queued = await http(harness)
        .post(`${API}/admin/notifications`)
        .set(asAdmin())
        .send({ audience: 'ALL_CUSTOMERS', title: 'Mistake', body: 'Sent by accident.' })
        .expect(201);

      const cancelled = await http(harness)
        .post(`${API}/admin/notifications/${queued.body.data.id}/cancel`)
        .set(asAdmin())
        .expect(200);
      expect(cancelled.body.data.status).toBe('CANCELLED');

      // Even if the worker picks the job up afterwards, nothing is sent.
      await harness.campaigns.deliver(queued.body.data.id);
      expect(await harness.prisma.notification.count()).toBe(0);
    });

    it('will not pretend to recall a message already delivered', async () => {
      await activate(harness);
      const campaignId = await sendAndDeliver({
        audience: 'ALL_CUSTOMERS',
        title: 'Gone',
        body: 'Already on their phones.',
      });

      const response = await http(harness)
        .post(`${API}/admin/notifications/${campaignId}/cancel`)
        .set(asAdmin())
        .expect(409);

      expect(response.body.code).toBe('CAMPAIGN_NOT_CANCELLABLE');
      expect(response.body.message).toContain('already finished');
    });
  });

  // ── Permissions ────────────────────────────────────────────────────────

  describe('permissions', () => {
    it('separates reading what was sent from sending', async () => {
      const reader = await adminAccount(harness, ['admin.access', 'notifications.view']);
      await activate(harness);

      await http(harness)
        .get(`${API}/admin/notifications`)
        .set({ Authorization: `Bearer ${reader.accessToken}` })
        .expect(200);

      await http(harness)
        .post(`${API}/admin/notifications/audience-preview`)
        .set({ Authorization: `Bearer ${reader.accessToken}` })
        .send({ audience: 'ALL_CUSTOMERS' })
        .expect(200);

      const refused = await http(harness)
        .post(`${API}/admin/notifications`)
        .set({ Authorization: `Bearer ${reader.accessToken}` })
        .send({ audience: 'ALL_CUSTOMERS', title: 'No', body: 'Not allowed' })
        .expect(403);

      expect(refused.body.message).toContain('send');
      expect(await harness.prisma.notificationCampaign.count()).toBe(0);
    });

    it('refuses a driver token outright', async () => {
      const driver = await readyDriver(harness, NEARBY, nextPhone());

      await http(harness)
        .get(`${API}/admin/notifications`)
        .set({ Authorization: `Bearer ${driver.accessToken}` })
        .expect(403);
    });
  });
});
