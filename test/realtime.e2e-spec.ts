import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import { createTestHarness, type TestHarness } from './app-harness.js';
import { API, activate, http, readyDriver, type ActivatedAccount } from './helpers.js';

const NEARBY = { latitude: 11.557, longitude: 104.929 };

describe('Realtime (e2e)', () => {
  let harness: TestHarness;
  let customer: ActivatedAccount;
  let driver: ActivatedAccount;
  let vehicleTypeId: string;
  const open: Socket[] = [];

  beforeAll(async () => {
    harness = await createTestHarness();
  });

  afterAll(async () => {
    for (const socket of open) socket.close();
    await harness.close();
  });

  beforeEach(async () => {
    for (const socket of open.splice(0)) socket.close();
    await harness.reset();
    harness.map.shouldFail = false;
    customer = await activate(harness);
    driver = await readyDriver(harness, NEARBY);
    vehicleTypeId = (await harness.prisma.vehicleType.findFirstOrThrow({ select: { id: true } })).id;
  });

  /** Opens a socket and resolves once the server has accepted it, or rejects. */
  function connect(token?: string): Promise<{ socket: Socket; rooms: string[] }> {
    return new Promise((resolve, reject) => {
      const socket = io(harness.url, {
        auth: token ? { token } : {},
        transports: ['websocket'],
        reconnection: false,
      });
      open.push(socket);

      const timer = setTimeout(() => reject(new Error('connection timed out')), 10_000);

      socket.on('connection.ready', (payload: { rooms: string[] }) => {
        clearTimeout(timer);
        resolve({ socket, rooms: payload.rooms });
      });
      socket.on('connection.error', (payload: { code: string }) => {
        clearTimeout(timer);
        reject(new Error(payload.code));
      });
      socket.on('connect_error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  const waitFor = <T>(socket: Socket, event: string, ms = 10_000): Promise<T> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${event} within ${ms}ms`)), ms);
      socket.once(event, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

  /** Nothing should arrive on this event — resolves true if the window passes quietly. */
  const expectSilence = (socket: Socket, event: string, ms = 1_500): Promise<boolean> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(true), ms);
      socket.once(event, () => {
        clearTimeout(timer);
        resolve(false);
      });
    });

  const bearer = (account: ActivatedAccount) => ({ Authorization: `Bearer ${account.accessToken}` });

  async function book(): Promise<string> {
    const response = await http(harness)
      .post(`${API}/mobile/customer/deliveries`)
      .set(bearer(customer))
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

    return response.body.data.id;
  }

  describe('connecting', () => {
    it('refuses a socket with no token', async () => {
      await expect(connect()).rejects.toThrow('UNAUTHORIZED');
    });

    it('refuses a forged token', async () => {
      await expect(connect('not.a.real.jwt')).rejects.toThrow('UNAUTHORIZED');
    });

    it('refuses a token from a revoked session', async () => {
      await http(harness).post(`${API}/auth/logout`).set(bearer(customer)).send({}).expect(200);

      await expect(connect(customer.accessToken)).rejects.toThrow();
    });

    it('puts a customer in their own room only', async () => {
      const { rooms } = await connect(customer.accessToken);

      expect(rooms).toEqual([`user:${customer.userId}`]);
    });

    it('puts a driver in both their user and driver rooms', async () => {
      const { rooms } = await connect(driver.accessToken);

      expect(rooms).toContain(`user:${driver.userId}`);
      expect(rooms).toContain(`driver:${driver.driverId}`);
    });

    it('rejoins the delivery a driver is already working after a reconnect', async () => {
      const deliveryId = await book();
      await harness.matching.runRound(deliveryId, 1);
      await http(harness).post(`${API}/mobile/driver/jobs/${deliveryId}/accept`).set(bearer(driver)).expect(200);

      const { rooms } = await connect(driver.accessToken);
      expect(rooms).toContain(`delivery:${deliveryId}`);
    });
  });

  describe('delivery rooms', () => {
    it('lets the customer who owns a delivery subscribe', async () => {
      const deliveryId = await book();
      const { socket } = await connect(customer.accessToken);

      const reply = waitFor<{ subscribed: boolean; room: string }>(socket, 'delivery.subscribed');
      socket.emit('delivery.subscribe', { deliveryId });

      expect(await reply).toMatchObject({ subscribed: true, room: `delivery:${deliveryId}` });
    });

    it('refuses a delivery that belongs to someone else', async () => {
      const deliveryId = await book();
      const stranger = await activate(harness);
      const { socket } = await connect(stranger.accessToken);

      const reply = waitFor<{ subscribed: boolean; code: string }>(socket, 'delivery.subscribed');
      socket.emit('delivery.subscribe', { deliveryId });

      expect(await reply).toMatchObject({ subscribed: false, code: 'DELIVERY_NOT_FOUND' });
    });

    it('reports an invalid payload in the same envelope as the REST API', async () => {
      const { socket } = await connect(customer.accessToken);

      const error = waitFor<{ success: boolean; code: string; errors: { field: string }[] }>(
        socket,
        'connection.error',
      );
      socket.emit('delivery.subscribe', { deliveryId: 'too-short' });

      const payload = await error;
      expect(payload.success).toBe(false);
      expect(payload.code).toBe('VALIDATION_ERROR');
      expect(payload.errors[0].field).toBe('deliveryId');
    });

    it('stops delivering events after unsubscribing', async () => {
      const deliveryId = await book();
      const { socket } = await connect(customer.accessToken);

      socket.emit('delivery.subscribe', { deliveryId });
      await waitFor(socket, 'delivery.subscribed');

      socket.emit('delivery.unsubscribe', { deliveryId });
      await waitFor(socket, 'delivery.unsubscribed');

      // The customer's own user room still gets status events, so watch a
      // delivery-room-only event instead.
      const quiet = expectSilence(socket, 'delivery.driver_location_updated');

      await harness.matching.runRound(deliveryId, 1);
      await http(harness).post(`${API}/mobile/driver/jobs/${deliveryId}/accept`).set(bearer(driver)).expect(200);
      await http(harness)
        .put(`${API}/mobile/driver/location`)
        .set(bearer(driver))
        .send({ latitude: 11.55, longitude: 104.92 })
        .expect(200);

      expect(await quiet).toBe(true);
    });
  });

  describe('pushing events', () => {
    it('pushes a job offer to the driver it was made to', async () => {
      const { socket } = await connect(driver.accessToken);

      const offer = waitFor<{ deliveryId: string; estimatedEarningAmount: number }>(
        socket,
        'driver.request.received',
      );

      const deliveryId = await book();
      await harness.matching.runRound(deliveryId, 1);

      const payload = await offer;
      expect(payload.deliveryId).toBe(deliveryId);
      expect(payload.estimatedEarningAmount).toBeGreaterThan(0);
    });

    it('does not push another driver’s offer', async () => {
      const other = await readyDriver(harness, { latitude: 11.75, longitude: 105.15 });
      const { socket } = await connect(other.accessToken);

      const quiet = expectSilence(socket, 'driver.request.received', 2_000);

      const deliveryId = await book();
      await harness.matching.runRound(deliveryId, 1);

      expect(await quiet).toBe(true);
    });

    it('tells the losing drivers to clear the offer once someone accepts', async () => {
      const loser = await readyDriver(harness, NEARBY);
      const { socket } = await connect(loser.accessToken);

      const deliveryId = await book();

      // The listener has to be attached before the event is emitted — `once`
      // does not replay what it missed.
      const offered = waitFor(socket, 'driver.request.received');
      await harness.matching.runRound(deliveryId, 1);
      await offered;

      const cancelled = waitFor<{ deliveryId: string }>(socket, 'driver.request.cancelled');
      await http(harness).post(`${API}/mobile/driver/jobs/${deliveryId}/accept`).set(bearer(driver)).expect(200);

      expect((await cancelled).deliveryId).toBe(deliveryId);
    });

    it('tells the customer when a driver is assigned, without them asking', async () => {
      const { socket } = await connect(customer.accessToken);
      const deliveryId = await book();
      await harness.matching.runRound(deliveryId, 1);

      const assigned = waitFor<{ status: string; bookingCode: string }>(socket, 'delivery.driver_assigned');
      await http(harness).post(`${API}/mobile/driver/jobs/${deliveryId}/accept`).set(bearer(driver)).expect(200);

      expect((await assigned).status).toBe('DRIVER_ASSIGNED');
    });

    it('pushes every execution step as it happens', async () => {
      const { socket } = await connect(customer.accessToken);
      const deliveryId = await book();
      await harness.matching.runRound(deliveryId, 1);
      await http(harness).post(`${API}/mobile/driver/jobs/${deliveryId}/accept`).set(bearer(driver)).expect(200);

      socket.emit('delivery.subscribe', { deliveryId });
      await waitFor(socket, 'delivery.subscribed');

      for (const [step, event, status] of [
        ['arrive-pickup', 'delivery.arrived_pickup', 'ARRIVED_PICKUP'],
        ['confirm-pickup', 'delivery.picked_up', 'PICKED_UP'],
        ['arrive-dropoff', 'delivery.arrived_dropoff', 'ARRIVED_DROPOFF'],
      ] as const) {
        const promise = waitFor<{ status: string }>(socket, event);
        await http(harness).post(`${API}/mobile/driver/jobs/${deliveryId}/${step}`).set(bearer(driver)).send({}).expect(200);
        expect((await promise).status).toBe(status);
      }
    });

    it('streams the driver’s position to the customer watching that delivery', async () => {
      const { socket } = await connect(customer.accessToken);
      const deliveryId = await book();
      await harness.matching.runRound(deliveryId, 1);
      await http(harness).post(`${API}/mobile/driver/jobs/${deliveryId}/accept`).set(bearer(driver)).expect(200);

      socket.emit('delivery.subscribe', { deliveryId });
      await waitFor(socket, 'delivery.subscribed');

      const moved = waitFor<{ latitude: number; longitude: number }>(socket, 'delivery.driver_location_updated');
      await http(harness)
        .put(`${API}/mobile/driver/location`)
        .set(bearer(driver))
        .send({ latitude: 11.5545, longitude: 104.926 })
        .expect(200);

      expect(await moved).toMatchObject({ latitude: 11.5545, longitude: 104.926 });
    });

    it('never streams a driver’s position to an unrelated customer', async () => {
      const deliveryId = await book();
      await harness.matching.runRound(deliveryId, 1);
      await http(harness).post(`${API}/mobile/driver/jobs/${deliveryId}/accept`).set(bearer(driver)).expect(200);

      const stranger = await activate(harness);
      const { socket } = await connect(stranger.accessToken);
      const quiet = expectSilence(socket, 'delivery.driver_location_updated', 2_000);

      await http(harness)
        .put(`${API}/mobile/driver/location`)
        .set(bearer(driver))
        .send({ latitude: 11.5545, longitude: 104.926 })
        .expect(200);

      expect(await quiet).toBe(true);
    });
  });

  describe('driver location over the socket', () => {
    it('accepts a position and applies the same rules as the REST endpoint', async () => {
      const { socket } = await connect(driver.accessToken);

      const accepted = waitFor<{ accepted: boolean }>(socket, 'driver.location.accepted');
      socket.emit('driver.location.push', { latitude: 11.5545, longitude: 104.926, heading: 200, speed: 7.5 });

      expect(await accepted).toEqual({ accepted: true });

      const fix = await harness.redis.getJson<{ latitude: number }>(`loc:driver:${driver.driverId}`);
      expect(fix?.latitude).toBe(11.5545);
    });

    it('refuses a position from a customer socket', async () => {
      const { socket } = await connect(customer.accessToken);

      const reply = waitFor<{ accepted: boolean; code: string }>(socket, 'driver.location.accepted');
      socket.emit('driver.location.push', { latitude: 11.5545, longitude: 104.926 });

      expect(await reply).toMatchObject({ accepted: false, code: 'ROLE_NOT_ALLOWED' });
    });

    it('rejects an impossible coordinate without killing the connection', async () => {
      const { socket } = await connect(driver.accessToken);

      const error = waitFor<{ code: string }>(socket, 'connection.error');
      socket.emit('driver.location.push', { latitude: 999, longitude: 104.926 });

      expect((await error).code).toBe('VALIDATION_ERROR');
      expect(socket.connected).toBe(true);
    });
  });
});
