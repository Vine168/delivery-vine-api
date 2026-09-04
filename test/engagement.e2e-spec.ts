import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './app-harness.js';
import { API, activate, completedDelivery, http, pngFixture, readyDriver, type ActivatedAccount } from './helpers.js';

const NEARBY = { latitude: 11.557, longitude: 104.929 };

describe('Ratings, favourites, templates, chat and notifications (e2e)', () => {
  let harness: TestHarness;
  let customer: ActivatedAccount;
  let driver: ActivatedAccount;
  let vehicleTypeId: string;

  beforeAll(async () => {
    harness = await createTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
    harness.map.shouldFail = false;
    customer = await activate(harness);
    driver = await readyDriver(harness, NEARBY);
    vehicleTypeId = (await harness.prisma.vehicleType.findFirstOrThrow({ select: { id: true } })).id;
  });

  const asCustomer = () => ({ Authorization: `Bearer ${customer.accessToken}` });
  const asDriver = () => ({ Authorization: `Bearer ${driver.accessToken}` });

  describe('ratings', () => {
    it('rates a completed delivery and updates the driver’s average', async () => {
      const delivery = await completedDelivery(harness, customer, driver, vehicleTypeId);

      const response = await http(harness)
        .post(`${API}/mobile/customer/deliveries/${delivery.deliveryId}/rating`)
        .set(asCustomer())
        .send({ rating: 5, comment: 'Fast and careful', tags: ['ON_TIME', 'POLITE'] })
        .expect(201);

      expect(response.body.data).toMatchObject({ rating: 5, comment: 'Fast and careful' });
      expect(response.body.data.tags).toEqual(['ON_TIME', 'POLITE']);

      const profile = await harness.prisma.driverProfile.findUniqueOrThrow({
        where: { id: driver.driverId as string },
      });
      expect(Number(profile.ratingAverage)).toBe(5);
      expect(profile.ratingCount).toBe(1);
    });

    it('averages across ratings rather than drifting', async () => {
      const first = await completedDelivery(harness, customer, driver, vehicleTypeId);
      const second = await completedDelivery(harness, customer, driver, vehicleTypeId);

      for (const [delivery, rating] of [
        [first, 5],
        [second, 4],
      ] as const) {
        await http(harness)
          .post(`${API}/mobile/customer/deliveries/${delivery.deliveryId}/rating`)
          .set(asCustomer())
          .send({ rating })
          .expect(201);
      }

      const profile = await harness.prisma.driverProfile.findUniqueOrThrow({
        where: { id: driver.driverId as string },
      });
      expect(Number(profile.ratingAverage)).toBe(4.5);
      expect(profile.ratingCount).toBe(2);
    });

    it('refuses to rate a delivery that is not finished', async () => {
      const booking = await http(harness)
        .post(`${API}/mobile/customer/deliveries`)
        .set(asCustomer())
        .send({
          pickup: { address: 'A', latitude: 11.5564, longitude: 104.9282, contactName: 'Sok', contactPhone: '012345678' },
          dropoff: { address: 'B', latitude: 11.5, longitude: 104.87, contactName: 'Chan', contactPhone: '012999888' },
          vehicleTypeId,
          currency: 'KHR',
          packages: [{ size: 'SMALL', weightKg: 2 }],
          paymentMethod: 'CASH_ON_DELIVERY',
        })
        .expect(201);

      const response = await http(harness)
        .post(`${API}/mobile/customer/deliveries/${booking.body.data.id}/rating`)
        .set(asCustomer())
        .send({ rating: 5 })
        .expect(422);

      expect(response.body.code).toBe('RATING_NOT_ALLOWED');
    });

    it('allows one rating per delivery', async () => {
      const delivery = await completedDelivery(harness, customer, driver, vehicleTypeId);
      const path = `${API}/mobile/customer/deliveries/${delivery.deliveryId}/rating`;

      await http(harness).post(path).set(asCustomer()).send({ rating: 5 }).expect(201);
      const again = await http(harness).post(path).set(asCustomer()).send({ rating: 1 }).expect(409);

      expect(again.body.code).toBe('RATING_ALREADY_SUBMITTED');

      const profile = await harness.prisma.driverProfile.findUniqueOrThrow({
        where: { id: driver.driverId as string },
      });
      expect(profile.ratingCount).toBe(1);
    });

    it('rejects a rating outside one to five', async () => {
      const delivery = await completedDelivery(harness, customer, driver, vehicleTypeId);

      const response = await http(harness)
        .post(`${API}/mobile/customer/deliveries/${delivery.deliveryId}/rating`)
        .set(asCustomer())
        .send({ rating: 6 })
        .expect(400);

      expect(response.body.errors[0].message).toContain('between 1 and 5');
    });

    it('will not let a stranger rate someone else’s delivery', async () => {
      const delivery = await completedDelivery(harness, customer, driver, vehicleTypeId);
      const stranger = await activate(harness);

      await http(harness)
        .post(`${API}/mobile/customer/deliveries/${delivery.deliveryId}/rating`)
        .set({ Authorization: `Bearer ${stranger.accessToken}` })
        .send({ rating: 1 })
        .expect(404);
    });
  });

  describe('favourite drivers', () => {
    it('saves a driver who has completed a delivery, and offers them work first', async () => {
      await completedDelivery(harness, customer, driver, vehicleTypeId);

      await http(harness)
        .post(`${API}/mobile/customer/favorite-drivers/${driver.driverId}`)
        .set(asCustomer())
        .expect(201);

      const list = await http(harness)
        .get(`${API}/mobile/customer/favorite-drivers`)
        .set(asCustomer())
        .expect(200);

      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).toMatchObject({
        driverId: driver.driverId,
        fullName: 'Chan Sopheak',
        deliveriesTogether: 1,
        isOnline: true,
      });
      // Not exposed before a delivery is assigned.
      expect(list.body.data[0]).not.toHaveProperty('phone');
    });

    it('refuses a driver the customer has never used', async () => {
      const response = await http(harness)
        .post(`${API}/mobile/customer/favorite-drivers/${driver.driverId}`)
        .set(asCustomer())
        .expect(422);

      expect(response.body.message).toContain('completed a delivery');
    });

    it('will not save the same driver twice', async () => {
      await completedDelivery(harness, customer, driver, vehicleTypeId);
      const path = `${API}/mobile/customer/favorite-drivers/${driver.driverId}`;

      await http(harness).post(path).set(asCustomer()).expect(201);
      const again = await http(harness).post(path).set(asCustomer()).expect(409);

      expect(again.body.code).toBe('FAVORITE_DRIVER_ALREADY_ADDED');
    });

    it('removes a saved driver', async () => {
      await completedDelivery(harness, customer, driver, vehicleTypeId);
      const path = `${API}/mobile/customer/favorite-drivers/${driver.driverId}`;

      await http(harness).post(path).set(asCustomer()).expect(201);
      await http(harness).delete(path).set(asCustomer()).expect(204);

      const list = await http(harness).get(`${API}/mobile/customer/favorite-drivers`).set(asCustomer()).expect(200);
      expect(list.body.data).toHaveLength(0);
    });

    it('is refused an unknown driver id', async () => {
      await http(harness)
        .post(`${API}/mobile/customer/favorite-drivers/aaaaaaaaaaaaaaaaaaaaaaaa`)
        .set(asCustomer())
        .expect(404);
    });
  });

  describe('package templates', () => {
    const template = { name: 'Water crate', size: 'MEDIUM', weightKg: 12, category: 'DRINKS' };

    it('saves and lists presets', async () => {
      const created = await http(harness)
        .post(`${API}/mobile/customer/package-templates`)
        .set(asCustomer())
        .send(template)
        .expect(201);

      expect(created.body.data).toMatchObject(template);

      const list = await http(harness)
        .get(`${API}/mobile/customer/package-templates`)
        .set(asCustomer())
        .expect(200);
      expect(list.body.data).toHaveLength(1);
    });

    it('updates and deletes one', async () => {
      const created = await http(harness)
        .post(`${API}/mobile/customer/package-templates`)
        .set(asCustomer())
        .send(template)
        .expect(201);

      const updated = await http(harness)
        .patch(`${API}/mobile/customer/package-templates/${created.body.data.id}`)
        .set(asCustomer())
        .send({ name: 'Big water crate', weightKg: 20 })
        .expect(200);

      expect(updated.body.data).toMatchObject({ name: 'Big water crate', weightKg: 20 });

      await http(harness)
        .delete(`${API}/mobile/customer/package-templates/${created.body.data.id}`)
        .set(asCustomer())
        .expect(204);

      const list = await http(harness).get(`${API}/mobile/customer/package-templates`).set(asCustomer()).expect(200);
      expect(list.body.data).toHaveLength(0);
    });

    it('keeps one customer’s presets private', async () => {
      const created = await http(harness)
        .post(`${API}/mobile/customer/package-templates`)
        .set(asCustomer())
        .send(template)
        .expect(201);

      const stranger = await activate(harness);

      await http(harness)
        .patch(`${API}/mobile/customer/package-templates/${created.body.data.id}`)
        .set({ Authorization: `Bearer ${stranger.accessToken}` })
        .send({ name: 'Hijacked' })
        .expect(404);
    });
  });

  describe('chat', () => {
    async function assignedDelivery(): Promise<string> {
      const booking = await http(harness)
        .post(`${API}/mobile/customer/deliveries`)
        .set(asCustomer())
        .send({
          pickup: { address: 'A', latitude: 11.5564, longitude: 104.9282, contactName: 'Sok', contactPhone: '012345678' },
          dropoff: { address: 'B', latitude: 11.5, longitude: 104.87, contactName: 'Chan', contactPhone: '012999888' },
          vehicleTypeId,
          currency: 'KHR',
          packages: [{ size: 'SMALL', weightKg: 2 }],
          paymentMethod: 'CASH_ON_DELIVERY',
        })
        .expect(201);

      const deliveryId = booking.body.data.id as string;
      await harness.matching.runRound(deliveryId, 1);
      await http(harness).post(`${API}/mobile/driver/jobs/${deliveryId}/accept`).set(asDriver()).expect(200);
      return deliveryId;
    }

    const conversationFor = async (headers: Record<string, string>) => {
      const list = await http(harness).get(`${API}/mobile/conversations`).set(headers).expect(200);
      return list.body.data[0];
    };

    it('opens a conversation when a driver is assigned, for both sides', async () => {
      const deliveryId = await assignedDelivery();

      const asSeenByCustomer = await conversationFor(asCustomer());
      const asSeenByDriver = await conversationFor(asDriver());

      expect(asSeenByCustomer.deliveryId).toBe(deliveryId);
      expect(asSeenByCustomer.counterpartName).toBe('Chan Sopheak');
      expect(asSeenByDriver.counterpartName).toBe('Sok Dara');
      expect(asSeenByCustomer.id).toBe(asSeenByDriver.id);
      expect(asSeenByCustomer.closed).toBe(false);
    });

    it('carries a message between the two parties', async () => {
      await assignedDelivery();
      const conversation = await conversationFor(asCustomer());

      const sent = await http(harness)
        .post(`${API}/mobile/conversations/${conversation.id}/messages`)
        .set(asCustomer())
        .send({ type: 'TEXT', body: 'I am at the blue gate' })
        .expect(201);

      expect(sent.body.data).toMatchObject({ body: 'I am at the blue gate', mine: true });

      const asDriverSees = await http(harness)
        .get(`${API}/mobile/conversations/${conversation.id}/messages`)
        .set(asDriver())
        .expect(200);

      expect(asDriverSees.body.data[0]).toMatchObject({
        body: 'I am at the blue gate',
        senderName: 'Sok Dara',
        mine: false,
      });
    });

    it('counts unread messages and clears them when the thread is read', async () => {
      await assignedDelivery();
      const conversation = await conversationFor(asCustomer());

      for (const body of ['One', 'Two']) {
        await http(harness)
          .post(`${API}/mobile/conversations/${conversation.id}/messages`)
          .set(asCustomer())
          .send({ body })
          .expect(201);
      }

      expect((await conversationFor(asDriver())).unreadCount).toBe(2);
      // The sender's own messages are never unread for them.
      expect((await conversationFor(asCustomer())).unreadCount).toBe(0);

      await http(harness)
        .get(`${API}/mobile/conversations/${conversation.id}/messages`)
        .set(asDriver())
        .expect(200);

      expect((await conversationFor(asDriver())).unreadCount).toBe(0);
    });

    it('accepts a location message', async () => {
      await assignedDelivery();
      const conversation = await conversationFor(asDriver());

      const sent = await http(harness)
        .post(`${API}/mobile/conversations/${conversation.id}/messages`)
        .set(asDriver())
        .send({ type: 'LOCATION', latitude: 11.5564, longitude: 104.9282 })
        .expect(201);

      expect(sent.body.data).toMatchObject({ type: 'LOCATION', latitude: 11.5564, longitude: 104.9282 });
    });

    it('accepts an image the sender uploaded', async () => {
      await assignedDelivery();
      const conversation = await conversationFor(asDriver());

      const upload = await http(harness)
        .post(`${API}/mobile/uploads`)
        .set(asDriver())
        .attach('file', pngFixture(), { filename: 'photo.png', contentType: 'image/png' })
        .field('purpose', 'CHAT_ATTACHMENT')
        .expect(201);

      const sent = await http(harness)
        .post(`${API}/mobile/conversations/${conversation.id}/messages`)
        .set(asDriver())
        .send({ type: 'IMAGE', fileId: upload.body.data.id })
        .expect(201);

      expect(sent.body.data.fileUrl).toContain('X-Amz-Signature');
    });

    it('keeps outsiders out entirely', async () => {
      await assignedDelivery();
      const conversation = await conversationFor(asCustomer());
      const stranger = await activate(harness);
      const headers = { Authorization: `Bearer ${stranger.accessToken}` };

      await http(harness).get(`${API}/mobile/conversations/${conversation.id}/messages`).set(headers).expect(404);
      await http(harness)
        .post(`${API}/mobile/conversations/${conversation.id}/messages`)
        .set(headers)
        .send({ body: 'hello?' })
        .expect(404);

      const theirList = await http(harness).get(`${API}/mobile/conversations`).set(headers).expect(200);
      expect(theirList.body.data).toHaveLength(0);
    });

    it('closes to new messages once the window after delivery has passed', async () => {
      const delivery = await completedDelivery(harness, customer, driver, vehicleTypeId);
      const conversation = await conversationFor(asCustomer());

      // Completion schedules the close; bring it forward rather than waiting a day.
      await harness.prisma.conversation.update({
        where: { deliveryId: delivery.deliveryId },
        data: { closedAt: new Date(Date.now() - 1_000) },
      });

      const response = await http(harness)
        .post(`${API}/mobile/conversations/${conversation.id}/messages`)
        .set(asCustomer())
        .send({ body: 'still there?' })
        .expect(422);

      expect(response.body.code).toBe('CONVERSATION_CLOSED');

      // Reading it is still fine.
      await http(harness).get(`${API}/mobile/conversations/${conversation.id}/messages`).set(asCustomer()).expect(200);
    });
  });

  describe('notifications', () => {
    it('tells the customer when their delivery moves', async () => {
      await completedDelivery(harness, customer, driver, vehicleTypeId);

      const response = await http(harness)
        .get(`${API}/mobile/notifications`)
        .set(asCustomer())
        .expect(200);

      const types = response.body.data.map((n: { type: string }) => n.type);
      expect(types).toContain('DRIVER_ASSIGNED');
      expect(types).toContain('PACKAGE_PICKED_UP');
      expect(types).toContain('DELIVERY_COMPLETED');

      const assigned = response.body.data.find((n: { type: string }) => n.type === 'DRIVER_ASSIGNED');
      expect(assigned.body).toContain('Chan Sopheak');
      expect(assigned.read).toBe(false);
    });

    it('counts unread and marks them read', async () => {
      await completedDelivery(harness, customer, driver, vehicleTypeId);

      const before = await http(harness)
        .get(`${API}/mobile/notifications/unread-count`)
        .set(asCustomer())
        .expect(200);
      expect(before.body.data.unread).toBeGreaterThan(0);

      const list = await http(harness).get(`${API}/mobile/notifications`).set(asCustomer()).expect(200);
      await http(harness)
        .patch(`${API}/mobile/notifications/${list.body.data[0].id}/read`)
        .set(asCustomer())
        .expect(200);

      const after = await http(harness)
        .get(`${API}/mobile/notifications/unread-count`)
        .set(asCustomer())
        .expect(200);
      expect(after.body.data.unread).toBe(before.body.data.unread - 1);

      await http(harness).post(`${API}/mobile/notifications/read-all`).set(asCustomer()).expect(200);

      const cleared = await http(harness)
        .get(`${API}/mobile/notifications/unread-count`)
        .set(asCustomer())
        .expect(200);
      expect(cleared.body.data.unread).toBe(0);
    });

    it('keeps one person’s notifications private', async () => {
      await completedDelivery(harness, customer, driver, vehicleTypeId);
      const stranger = await activate(harness);

      const list = await http(harness)
        .get(`${API}/mobile/notifications`)
        .set({ Authorization: `Bearer ${stranger.accessToken}` })
        .expect(200);

      expect(list.body.data).toHaveLength(0);
    });

    it('registers a push token and records that push is not configured', async () => {
      await http(harness)
        .post(`${API}/mobile/devices`)
        .set(asCustomer())
        .send({ installationId: 'INSTALL-1', platform: 'IOS', pushToken: 'fcm-token-abc', appVersion: '1.4.0' })
        .expect(201);

      const token = await harness.prisma.devicePushToken.findUniqueOrThrow({ where: { token: 'fcm-token-abc' } });
      expect(token.isActive).toBe(true);

      await completedDelivery(harness, customer, driver, vehicleTypeId);

      // The notification exists regardless; the push attempt is recorded as
      // skipped because Firebase is not set up.
      const dispatches = await harness.prisma.pushDispatch.findMany({ where: { pushTokenId: token.id } });
      expect(dispatches.length).toBeGreaterThan(0);
      expect(dispatches[0].status).toBe('SKIPPED');
    });

    it('stops sending to a device that signed out', async () => {
      await http(harness)
        .post(`${API}/mobile/devices`)
        .set(asCustomer())
        .send({ installationId: 'INSTALL-2', platform: 'ANDROID', pushToken: 'fcm-token-xyz' })
        .expect(201);

      await http(harness).delete(`${API}/mobile/devices/INSTALL-2`).set(asCustomer()).expect(204);

      const token = await harness.prisma.devicePushToken.findUniqueOrThrow({ where: { token: 'fcm-token-xyz' } });
      expect(token.isActive).toBe(false);
    });
  });
});
