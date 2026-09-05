import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './app-harness.js';
import { API, activate, http, nextPhone, readyDriver, type ActivatedAccount } from './helpers.js';

const PASSWORD = 'Passw0rd1';
const WRONG = 'not-the-password';

/**
 * The route's rate limit is keyed by IP, so it never protected a particular
 * account: an attacker with many addresses gets a budget each against the same
 * number. These failures are counted against the account itself.
 *
 * One phone holds a separate customer, driver and back-office account, so the
 * lock has to follow the account and not the person — otherwise guessing at
 * someone's customer password would stop them driving.
 */
describe('Sign-in lockout (e2e)', () => {
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

  const attempt = (phone: string, role: string, password = WRONG) =>
    http(harness).post(`${API}/auth/login`).send({ phone, password, role });

  /** Exhausts the allowance for one account. */
  async function failUntilLocked(phone: string, role: string): Promise<number> {
    for (let i = 1; i <= 12; i += 1) {
      const response = await attempt(phone, role);
      if (response.status === 429) return i;
    }
    return -1;
  }

  describe('a targeted account', () => {
    it('locks after repeated failures, and says how long for', async () => {
      const customer = await activate(harness);

      const lockedOn = await failUntilLocked(customer.phone, 'CUSTOMER');
      expect(lockedOn).toBeGreaterThan(1);
      expect(lockedOn).toBeLessThanOrEqual(11);

      const response = await attempt(customer.phone, 'CUSTOMER');
      expect(response.status).toBe(429);
      expect(response.body.code).toBe('ACCOUNT_TEMPORARILY_LOCKED');
      expect(response.body.message).toMatch(/minute/i);
    });

    it('refuses even the correct password while locked', async () => {
      const customer = await activate(harness);
      await failUntilLocked(customer.phone, 'CUSTOMER');

      // The point of a lockout: knowing the password later does not help an
      // attacker who has just been guessing.
      const response = await attempt(customer.phone, 'CUSTOMER', PASSWORD);
      expect(response.status).toBe(429);
    });

    it('counts failures for numbers with no account, so probing looks the same', async () => {
      const unknown = nextPhone();

      const lockedOn = await failUntilLocked(unknown, 'CUSTOMER');

      // Enumerating which numbers exist should not be cheaper than guessing a
      // password.
      expect(lockedOn).toBeGreaterThan(1);
      expect(lockedOn).toBeLessThanOrEqual(11);
    });

    it('forgets the failures once someone signs in successfully', async () => {
      const customer = await activate(harness);

      for (let i = 0; i < 5; i += 1) await attempt(customer.phone, 'CUSTOMER');
      await attempt(customer.phone, 'CUSTOMER', PASSWORD).expect(200);

      // The counter is cleared, so the next slip does not inherit the earlier
      // ones.
      for (let i = 0; i < 5; i += 1) {
        expect((await attempt(customer.phone, 'CUSTOMER')).status).toBe(401);
      }
    });
  });

  describe('one phone, two apps', () => {
    it('locking the customer account leaves the same person driving', async () => {
      const phone = nextPhone();
      const customer = await activate(harness, 'CUSTOMER', phone);
      await harness.expireOtpCooldowns();
      const driver = await readyDriver(harness, { latitude: 11.557, longitude: 104.929 }, phone);

      expect(customer.phone).toBe(driver.phone);

      await failUntilLocked(phone, 'CUSTOMER');
      expect((await attempt(phone, 'CUSTOMER', PASSWORD)).status).toBe(429);

      // Their livelihood is a separate account and is untouched.
      await attempt(phone, 'DRIVER', PASSWORD).expect(200);
    });

    it('locking the driver account leaves them able to order a delivery', async () => {
      const phone = nextPhone();
      await activate(harness, 'CUSTOMER', phone);
      await harness.expireOtpCooldowns();
      await readyDriver(harness, { latitude: 11.557, longitude: 104.929 }, phone);

      await failUntilLocked(phone, 'DRIVER');
      expect((await attempt(phone, 'DRIVER', PASSWORD)).status).toBe(429);

      await attempt(phone, 'CUSTOMER', PASSWORD).expect(200);
    });

    it('keeps one person’s failures away from another’s account', async () => {
      const mine = await activate(harness);
      const theirs = await activate(harness);

      await failUntilLocked(mine.phone, 'CUSTOMER');

      await attempt(theirs.phone, 'CUSTOMER', PASSWORD).expect(200);
    });
  });

  describe('an existing session', () => {
    it('keeps working while the account is locked out of new sign-ins', async () => {
      const customer = await activate(harness);
      await failUntilLocked(customer.phone, 'CUSTOMER');

      // A lockout is about guessing the password, not about punishing someone
      // already signed in on their own phone.
      await http(harness)
        .get(`${API}/mobile/customer/profile`)
        .set({ Authorization: `Bearer ${customer.accessToken}` })
        .expect(200);
    });
  });
});
