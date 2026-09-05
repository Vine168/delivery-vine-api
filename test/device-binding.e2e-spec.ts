import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './app-harness.js';
import { API, activate, http, nextPhone, readyDriver } from './helpers.js';

const THIS_PHONE = { installationId: 'INSTALL-AAAA-1111', platform: 'ANDROID' };
const THIEFS_PHONE = { installationId: 'INSTALL-BBBB-2222', platform: 'IOS' };

/**
 * Rotation already catches a stolen refresh token the second time it is used.
 * Binding refuses it the first time, on a device that is not the one that
 * signed in.
 */
describe('Device-bound refresh (e2e)', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await createTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  /** Signs in, naming the device, and returns the refresh token. */
  async function signIn(phone: string, role: string, device: Record<string, string>): Promise<string> {
    const response = await http(harness)
      .post(`${API}/auth/login`)
      .send({ phone, password: 'Passw0rd1', role, device })
      .expect(200);

    return response.body.data.tokens.refreshToken as string;
  }

  const refresh = (refreshToken: string, device?: Record<string, string>) =>
    http(harness)
      .post(`${API}/auth/refresh`)
      .send(device ? { refreshToken, device } : { refreshToken });

  describe('a token lifted onto another phone', () => {
    it('is refused, and the whole family is burned', async () => {
      const customer = await activate(harness);
      const token = await signIn(customer.phone, 'CUSTOMER', THIS_PHONE);

      const stolen = await refresh(token, THIEFS_PHONE).expect(401);
      expect(stolen.body.code).toBe('REFRESH_TOKEN_REUSED');

      // Burned: the real phone cannot use it either, so the theft ends the
      // session rather than quietly sharing it.
      await refresh(token, THIS_PHONE).expect(401);
    });
  });

  describe('the device that signed in', () => {
    it('refreshes normally', async () => {
      const customer = await activate(harness);
      const token = await signIn(customer.phone, 'CUSTOMER', THIS_PHONE);

      const response = await refresh(token, THIS_PHONE).expect(200);
      expect(response.body.data.accessToken).toBeTruthy();
      expect(response.body.data.refreshToken).not.toBe(token);
    });

    it('keeps working across several rotations', async () => {
      const customer = await activate(harness);
      let token = await signIn(customer.phone, 'CUSTOMER', THIS_PHONE);

      for (let i = 0; i < 3; i += 1) {
        const response = await refresh(token, THIS_PHONE).expect(200);
        token = response.body.data.refreshToken as string;
      }

      await http(harness)
        .get(`${API}/mobile/customer/profile`)
        .set({ Authorization: `Bearer ${(await refresh(token, THIS_PHONE).expect(200)).body.data.accessToken}` })
        .expect(200);
    });
  });

  describe('an app build that names no device', () => {
    it('still refreshes, so shipping this does not sign everyone out', async () => {
      const customer = await activate(harness);
      const token = await signIn(customer.phone, 'CUSTOMER', THIS_PHONE);

      // Older clients send only the token. Refusing these by default would
      // have logged out every user on the day this shipped.
      await refresh(token).expect(200);
    });

    it('is refused once the platform is told every app sends one', async () => {
      const customer = await activate(harness);
      const token = await signIn(customer.phone, 'CUSTOMER', THIS_PHONE);

      const tokens = harness.app.get(
        (await import('../src/modules/auth/services/token.service.js')).TokenService,
      );
      const strict = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(tokens) as object,
        'requireDeviceOnRefresh',
      );
      Object.defineProperty(Object.getPrototypeOf(tokens) as object, 'requireDeviceOnRefresh', {
        get: () => true,
        configurable: true,
      });

      try {
        const response = await refresh(token).expect(401);
        expect(response.body.code).toBe('REFRESH_TOKEN_INVALID');
      } finally {
        if (strict) {
          Object.defineProperty(Object.getPrototypeOf(tokens) as object, 'requireDeviceOnRefresh', strict);
        }
      }
    });
  });

  describe('a session that never named a device', () => {
    it('is left alone, because there is nothing to bind it to', async () => {
      const customer = await activate(harness);

      // No device at sign-in, so no binding — and it keeps working whatever
      // the refresh says.
      const response = await http(harness)
        .post(`${API}/auth/login`)
        .send({ phone: customer.phone, password: 'Passw0rd1', role: 'CUSTOMER' })
        .expect(200);

      await refresh(response.body.data.tokens.refreshToken as string, THIEFS_PHONE).expect(200);
    });
  });

  describe('one phone, two apps', () => {
    it('gives the customer and driver apps separate, independent sessions', async () => {
      const phone = nextPhone();
      await activate(harness, 'CUSTOMER', phone);
      await harness.expireOtpCooldowns();
      await readyDriver(harness, { latitude: 11.557, longitude: 104.929 }, phone);

      // Two apps on one handset are two installations.
      const customerApp = { installationId: 'INSTALL-CUSTOMER-APP', platform: 'ANDROID' };
      const driverApp = { installationId: 'INSTALL-DRIVER-APP', platform: 'ANDROID' };

      const customerToken = await signIn(phone, 'CUSTOMER', customerApp);
      const driverToken = await signIn(phone, 'DRIVER', driverApp);

      // Each refreshes with its own installation…
      await refresh(customerToken, customerApp).expect(200);
      await refresh(driverToken, driverApp).expect(200);

      // …and neither can refresh the other's session.
      const crossed = await signIn(phone, 'CUSTOMER', customerApp);
      await refresh(crossed, driverApp).expect(401);
    });
  });
});
