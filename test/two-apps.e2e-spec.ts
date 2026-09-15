import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import { createTestHarness, type TestHarness } from './app-harness.js';
import { API, activate, adminAccount, http, nextPhone, readyDriver } from './helpers.js';
import { NotificationsService } from '../src/modules/notifications/notifications.service.js';

const NEARBY = { latitude: 11.557, longitude: 104.929 };
const PASSWORD = 'Passw0rd1';

/**
 * One person, one account, two apps. What each app is told — the name it
 * shows, the notifications it gets, the live events it hears — follows the app
 * that signed in, not the account.
 */
describe('One account in both apps (e2e)', () => {
  let harness: TestHarness;
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
  });

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Someone who orders and also drives: one account, both profiles, approved. */
  async function personWhoDrives() {
    const phone = nextPhone();
    const customer = await activate(harness, 'CUSTOMER', phone);
    await harness.expireOtpCooldowns();
    const driver = await readyDriver(harness, NEARBY, phone);

    return { phone, userId: customer.userId, driverId: driver.driverId as string };
  }

  /** Signs the account in as one app, on that app's own installation. */
  async function signInAs(phone: string, app: 'CUSTOMER' | 'DRIVER', installationId = `${app}-${phone}`) {
    const response = await http(harness)
      .post(`${API}/auth/login`)
      .send({ phone, password: PASSWORD, device: { installationId, platform: 'ANDROID', app } })
      .expect(200);

    return {
      accessToken: response.body.data.tokens.accessToken as string,
      user: response.body.data.user as Record<string, unknown>,
      installationId,
    };
  }

  /** Resolves with the rooms the server put the socket in. */
  function roomsFor(token: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const socket = io(harness.url, { auth: { token }, transports: ['websocket'], reconnection: false });
      open.push(socket);

      const timer = setTimeout(() => reject(new Error('connection timed out')), 10_000);
      socket.on('connection.ready', (payload: { rooms: string[] }) => {
        clearTimeout(timer);
        resolve(payload.rooms);
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

  /** Event listeners run after the request that set them off has answered. */
  async function eventually(check: () => Promise<boolean>, ms = 3_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('condition not met in time');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  describe('signing in', () => {
    it('names the person by the profile of the app that signed in', async () => {
      const person = await personWhoDrives();
      await harness.prisma.driverProfile.update({ where: { id: person.driverId }, data: { fullName: 'SOK DARA' } });

      const asCustomer = await signInAs(person.phone, 'CUSTOMER');
      const asDriver = await signInAs(person.phone, 'DRIVER');

      expect(asCustomer.user.fullName).toBe('Sok Dara');
      expect(asDriver.user.fullName).toBe('SOK DARA');
      // Enough for the driver app to pick its first screen without asking again.
      expect(asDriver.user).toMatchObject({ driverApprovalStatus: 'ACTIVE', customerSuspended: false });
    });

    it('recognises an older build by the role it still sends', async () => {
      const person = await personWhoDrives();

      await http(harness)
        .post(`${API}/auth/login`)
        .send({ phone: person.phone, password: PASSWORD, role: 'DRIVER' })
        .expect(200);

      const latest = await harness.prisma.userSession.findFirstOrThrow({
        where: { userId: person.userId },
        orderBy: { createdAt: 'desc' },
      });
      expect(latest.app).toBe('DRIVER');
    });

    it('points an existing customer who signs up in the driver app to sign in instead', async () => {
      const customer = await activate(harness);
      await harness.expireOtpCooldowns();

      const response = await http(harness)
        .post(`${API}/auth/driver/register`)
        .send({ phone: customer.phone, fullName: 'Sok Dara' })
        .expect(409);

      expect(response.body.code).toBe('ACCOUNT_ALREADY_EXISTS');
      expect(response.body.message).toContain('Sign in with the same password');
    });

    it('tells the account holder when a new device signs in, but not about the first', async () => {
      const customer = await activate(harness);
      const newSignIns = () =>
        harness.prisma.notification.count({ where: { userId: customer.userId, type: 'NEW_SIGN_IN' } });

      await signInAs(customer.phone, 'CUSTOMER', 'phone-one');
      await signInAs(customer.phone, 'CUSTOMER', 'phone-one');
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await newSignIns()).toBe(0);

      await signInAs(customer.phone, 'DRIVER', 'phone-two');
      await eventually(async () => (await newSignIns()) === 1);
    });
  });

  describe('what each app is sent', () => {
    it('pushes a notification to the app it belongs to, and keeps each inbox to its own', async () => {
      const person = await personWhoDrives();
      const asCustomer = await signInAs(person.phone, 'CUSTOMER');
      const asDriver = await signInAs(person.phone, 'DRIVER');

      for (const [session, pushToken] of [
        [asCustomer, 'customer-token'],
        [asDriver, 'driver-token'],
      ] as const) {
        await http(harness)
          .post(`${API}/mobile/devices`)
          .set(bearer(session.accessToken))
          .send({ installationId: session.installationId, platform: 'ANDROID', pushToken })
          .expect(201);
      }

      const notifications = harness.app.get(NotificationsService);
      await notifications.create({ userId: person.userId, type: 'WITHDRAWAL_STATUS_UPDATED', title: 'Payout sent', body: 'On its way.' });
      await notifications.create({ userId: person.userId, type: 'DRIVER_ASSIGNED', title: 'Driver on the way', body: 'Coming.' });
      await notifications.create({ userId: person.userId, type: 'SYSTEM_ANNOUNCEMENT', title: 'Hello', body: 'Everyone.' });

      // The payout notice reaches the driver app's phone and no other.
      const payout = await harness.prisma.notification.findFirstOrThrow({
        where: { userId: person.userId, type: 'WITHDRAWAL_STATUS_UPDATED' },
      });
      const pushed = await harness.prisma.pushDispatch.findMany({
        where: { notificationId: payout.id },
        select: { pushToken: { select: { token: true } } },
      });
      expect(pushed.map((row) => row.pushToken.token)).toEqual(['driver-token']);

      const inbox = async (token: string): Promise<string[]> => {
        const response = await http(harness).get(`${API}/mobile/notifications`).set(bearer(token)).expect(200);
        return (response.body.data as { type: string }[])
          .map((row) => row.type)
          .filter((type) => type !== 'NEW_SIGN_IN')
          .sort();
      };

      expect(await inbox(asCustomer.accessToken)).toEqual(['DRIVER_ASSIGNED', 'SYSTEM_ANNOUNCEMENT']);
      expect(await inbox(asDriver.accessToken)).toEqual(['SYSTEM_ANNOUNCEMENT', 'WITHDRAWAL_STATUS_UPDATED']);
    });

    it('keeps job offers out of the customer app’s socket', async () => {
      const person = await personWhoDrives();
      const asCustomer = await signInAs(person.phone, 'CUSTOMER');
      const asDriver = await signInAs(person.phone, 'DRIVER');

      const customerRooms = await roomsFor(asCustomer.accessToken);
      expect(customerRooms).toContain(`user:${person.userId}:CUSTOMER`);
      expect(customerRooms).not.toContain(`driver:${person.driverId}`);

      const driverRooms = await roomsFor(asDriver.accessToken);
      expect(driverRooms).toContain(`user:${person.userId}:DRIVER`);
      expect(driverRooms).toContain(`driver:${person.driverId}`);
    });

    it('lands a campaign for customers in the customer app', async () => {
      const person = await personWhoDrives();
      const campaign = await harness.prisma.notificationCampaign.create({
        data: {
          title: 'Ten percent off',
          body: 'This week only.',
          type: 'PROMOTION',
          audience: 'ALL_CUSTOMERS',
          createdByUserId: person.userId,
        },
      });

      await harness.campaigns.deliver(campaign.id);

      const received = await harness.prisma.notification.findFirstOrThrow({
        where: { userId: person.userId, type: 'PROMOTION' },
      });
      expect(received.app).toBe('CUSTOMER');
    });
  });

  describe('GET /mobile/me', () => {
    it('shows a customer with no driver side', async () => {
      const customer = await activate(harness);

      const response = await http(harness).get(`${API}/mobile/me`).set(bearer(customer.accessToken)).expect(200);

      expect(response.body.data.account.app).toBe('CUSTOMER');
      expect(response.body.data.customer).toMatchObject({ id: customer.customerId, suspended: false });
      expect(response.body.data.driver).toBeNull();
    });

    it('shows an applicant what still stands between them and going online', async () => {
      const applicant = await activate(harness, 'DRIVER');

      const response = await http(harness).get(`${API}/mobile/me`).set(bearer(applicant.accessToken)).expect(200);

      expect(response.body.data.driver).toMatchObject({
        id: applicant.driverId,
        approvalStatus: 'PENDING_APPROVAL',
        submittedAt: null,
        canGoOnline: false,
      });
      expect(response.body.data.driver.blockers).toContain('DRIVER_NOT_APPROVED');
    });

    it('still answers for a customer barred from booking', async () => {
      const customer = await activate(harness);
      await harness.prisma.customerProfile.update({
        where: { id: customer.customerId as string },
        data: { suspendedAt: new Date(), suspendedReason: 'Chargebacks' },
      });

      const response = await http(harness).get(`${API}/mobile/me`).set(bearer(customer.accessToken)).expect(200);

      expect(response.body.data.customer.suspended).toBe(true);
    });
  });

  describe('confirming the password before money moves', () => {
    const BANK = { bankName: 'ABA Bank', accountHolderName: 'CHAN SOPHEAK', accountNumber: '000123456789' };

    it('confirms the right password only, without treating a wrong one as a dead session', async () => {
      const driver = await readyDriver(harness, NEARBY);

      const wrong = await http(harness)
        .post(`${API}/auth/step-up`)
        .set(bearer(driver.accessToken))
        .send({ password: 'NotThePassword1' })
        .expect(403);
      expect(wrong.body.code).toBe('INVALID_CREDENTIALS');

      const right = await http(harness)
        .post(`${API}/auth/step-up`)
        .set(bearer(driver.accessToken))
        .send({ password: PASSWORD })
        .expect(200);
      expect(right.body.data.stepUpToken).toEqual(expect.any(String));
    });

    it('accepts a confirmation only on the session that made it', async () => {
      const driver = await readyDriver(harness, NEARBY);
      const elsewhere = await signInAs(driver.phone, 'DRIVER');

      const confirmation = await http(harness)
        .post(`${API}/auth/step-up`)
        .set(bearer(elsewhere.accessToken))
        .send({ password: PASSWORD })
        .expect(200);
      const token = confirmation.body.data.stepUpToken as string;

      const refused = await http(harness)
        .put(`${API}/mobile/driver/withdrawal-settings`)
        .set({ ...bearer(driver.accessToken), 'X-Step-Up-Token': token })
        .send(BANK)
        .expect(403);
      expect(refused.body.code).toBe('STEP_UP_REQUIRED');

      await http(harness)
        .put(`${API}/mobile/driver/withdrawal-settings`)
        .set({ ...bearer(elsewhere.accessToken), 'X-Step-Up-Token': token })
        .send(BANK)
        .expect(200);
    });
  });

  describe('the driver’s name', () => {
    it('can be corrected until approval, and only by support after', async () => {
      const applicant = await activate(harness, 'DRIVER');
      await http(harness)
        .patch(`${API}/mobile/driver/profile`)
        .set(bearer(applicant.accessToken))
        .send({ fullName: 'Chan Sopheak Dara' })
        .expect(200);

      const approved = await readyDriver(harness, NEARBY);
      const refused = await http(harness)
        .patch(`${API}/mobile/driver/profile`)
        .set(bearer(approved.accessToken))
        .send({ fullName: 'Someone Else' })
        .expect(409);
      expect(refused.body.code).toBe('DRIVER_NAME_LOCKED');

      // Sending back the name they already have is not a change.
      const current = await harness.prisma.driverProfile.findUniqueOrThrow({
        where: { id: approved.driverId as string },
      });
      await http(harness)
        .patch(`${API}/mobile/driver/profile`)
        .set(bearer(approved.accessToken))
        .send({ fullName: current.fullName })
        .expect(200);
    });
  });

  describe('after the merge', () => {
    it('refuses a DRIVER-role account at the database', async () => {
      await expect(
        harness.prisma.user.create({ data: { phone: '+85512000999', role: 'DRIVER' } }),
      ).rejects.toThrow();
    });

    it('lets an operator leave out drivers who have never booked', async () => {
      const admin = await adminAccount(harness, ['admin.access', 'customers.view']);
      const driver = await readyDriver(harness, NEARBY);

      const listed = async (hasOrdered: boolean): Promise<string[]> => {
        const response = await http(harness)
          .get(`${API}/admin/customers`)
          .query({ hasOrdered })
          .set(bearer(admin.accessToken))
          .expect(200);
        return (response.body.data as { id: string }[]).map((row) => row.id);
      };

      // A driver holds a customer profile, but has never booked anything.
      expect(await listed(false)).toContain(driver.customerId);
      expect(await listed(true)).not.toContain(driver.customerId);
    });
  });
});
