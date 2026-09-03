import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestHarness, type TestHarness } from './app-harness.js';

const API = '/api/v1';

describe('Authentication (e2e)', () => {
  let harness: TestHarness;
  let http: () => request.Agent;

  beforeAll(async () => {
    harness = await createTestHarness();
    http = () => request(harness.app.getHttpServer() as Parameters<typeof request>[0]);
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  /** Walks a phone number from registration to a usable session. */
  async function registerAndActivate(phone: string, role: 'CUSTOMER' | 'DRIVER' = 'CUSTOMER') {
    const path = role === 'CUSTOMER' ? 'customer' : 'driver';

    const registered = await http()
      .post(`${API}/auth/${path}/register`)
      .send({ phone, fullName: 'Test User' })
      .expect(201);

    const code = registered.body.data.otp.debugCode as string;

    const verified = await http()
      .post(`${API}/auth/otp/verify`)
      .send({ identifier: phone, channel: 'SMS', purpose: 'REGISTRATION', role, code })
      .expect(200);

    const activated = await http()
      .post(`${API}/auth/${path}/set-password`)
      .send({
        phone,
        verificationToken: verified.body.data.verificationToken,
        password: 'Passw0rd1',
      })
      .expect(200);

    return activated.body.data as {
      user: { id: string; role: string; customerId: string | null; driverId: string | null };
      tokens: { accessToken: string; refreshToken: string };
    };
  }

  describe('response envelope', () => {
    it('wraps success in the documented shape', async () => {
      const response = await http()
        .post(`${API}/auth/customer/register`)
        .send({ phone: '012000001', fullName: 'Envelope Test' })
        .expect(201);

      expect(response.body).toMatchObject({
        success: true,
        code: 'REGISTERED',
        meta: null,
      });
      expect(typeof response.body.message).toBe('string');
      expect(response.body.data.userId).toBeTruthy();
    });

    it('wraps validation failures with per-field errors', async () => {
      const response = await http()
        .post(`${API}/auth/customer/register`)
        .send({ phone: 'nonsense', fullName: '' })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(response.body.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'phone' })]),
      );
      expect(response.body.requestId).toBeTruthy();
    });

    it('rejects unknown properties instead of silently ignoring them', async () => {
      const response = await http()
        .post(`${API}/auth/customer/register`)
        .send({ phone: '012000002', fullName: 'X', role: 'ADMIN' })
        .expect(400);

      expect(response.body.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'role' })]),
      );
    });
  });

  describe('registration', () => {
    it('normalises every phone format to one stored value', async () => {
      await registerAndActivate('012000010');

      const user = await harness.prisma.user.findFirst({ where: { phone: '+85512000010' } });
      expect(user).not.toBeNull();
      expect(user?.status).toBe('ACTIVE');
    });

    it('never persists the OTP in plaintext', async () => {
      const registered = await http()
        .post(`${API}/auth/customer/register`)
        .send({ phone: '012000011', fullName: 'Secret' })
        .expect(201);

      const code = registered.body.data.otp.debugCode as string;
      const rows = await harness.prisma.otpVerification.findMany();

      expect(rows).toHaveLength(1);
      expect(rows[0].codeHash).not.toContain(code);
      expect(rows[0].codeHash).toHaveLength(64);
    });

    it('rejects a second registration for the same phone and role', async () => {
      await registerAndActivate('012000012');

      const response = await http()
        .post(`${API}/auth/customer/register`)
        .send({ phone: '012000012', fullName: 'Impostor' })
        .expect(409);

      expect(response.body.code).toBe('ACCOUNT_ALREADY_EXISTS');
    });

    it('allows the same phone to hold both a customer and a driver account', async () => {
      const customer = await registerAndActivate('012000013', 'CUSTOMER');
      const driver = await registerAndActivate('012000013', 'DRIVER');

      expect(customer.user.id).not.toBe(driver.user.id);
      expect(customer.user.customerId).toBeTruthy();
      expect(customer.user.driverId).toBeNull();
      expect(driver.user.driverId).toBeTruthy();
      expect(driver.user.customerId).toBeNull();
    });
  });

  describe('login', () => {
    it('signs in with the right credentials and role', async () => {
      await registerAndActivate('012000020');

      const response = await http()
        .post(`${API}/auth/login`)
        .send({ phone: '012000020', password: 'Passw0rd1', role: 'CUSTOMER' })
        .expect(200);

      expect(response.body.code).toBe('LOGGED_IN');
      expect(response.body.data.tokens.accessToken).toBeTruthy();
    });

    it('rejects a wrong password', async () => {
      await registerAndActivate('012000021');

      const response = await http()
        .post(`${API}/auth/login`)
        .send({ phone: '012000021', password: 'WrongPass9', role: 'CUSTOMER' })
        .expect(401);

      expect(response.body.code).toBe('INVALID_CREDENTIALS');
    });

    it('does not let a customer sign in through the driver role', async () => {
      await registerAndActivate('012000022', 'CUSTOMER');

      const response = await http()
        .post(`${API}/auth/login`)
        .send({ phone: '012000022', password: 'Passw0rd1', role: 'DRIVER' })
        .expect(401);

      expect(response.body.code).toBe('INVALID_CREDENTIALS');
    });

    it('never returns the password hash', async () => {
      const session = await registerAndActivate('012000023');
      expect(JSON.stringify(session)).not.toContain('$argon2');
    });
  });

  describe('token rotation', () => {
    it('issues a new pair and invalidates the old refresh token', async () => {
      const { tokens } = await registerAndActivate('012000030');

      const rotated = await http()
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(200);

      expect(rotated.body.data.refreshToken).not.toBe(tokens.refreshToken);

      const replay = await http()
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(401);

      expect(replay.body.code).toBe('REFRESH_TOKEN_REUSED');
    });

    it('revokes the whole family when a token is replayed', async () => {
      const { tokens } = await registerAndActivate('012000031');

      const rotated = await http()
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(200);

      // Replaying the original burns the family…
      await http().post(`${API}/auth/refresh`).send({ refreshToken: tokens.refreshToken }).expect(401);

      // …so the legitimately rotated token is dead too.
      const afterBurn = await http()
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: rotated.body.data.refreshToken })
        .expect(401);

      expect(afterBurn.body.code).toBe('REFRESH_TOKEN_REUSED');
    });
  });

  describe('protected routes', () => {
    it('refuses a request with no token', async () => {
      const response = await http().post(`${API}/auth/logout`).send({}).expect(401);
      expect(response.body.code).toBe('UNAUTHORIZED');
    });

    it('refuses a forged token', async () => {
      const response = await http()
        .post(`${API}/auth/logout`)
        .set('Authorization', 'Bearer not.a.jwt')
        .send({})
        .expect(401);

      expect(response.body.code).toBe('UNAUTHORIZED');
    });

    it('accepts a valid token and ends the session on logout', async () => {
      const { tokens } = await registerAndActivate('012000040');

      await http()
        .post(`${API}/auth/logout`)
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .send({})
        .expect(200);

      // The refresh token belonged to the session we just revoked.
      await http().post(`${API}/auth/refresh`).send({ refreshToken: tokens.refreshToken }).expect(401);
    });
  });

  describe('password reset', () => {
    it('resets the password and revokes every existing session', async () => {
      const phone = '012000050';
      const { tokens } = await registerAndActivate(phone);

      const requested = await http()
        .post(`${API}/auth/forgot-password`)
        .send({ phone, role: 'CUSTOMER' })
        .expect(200);

      const verified = await http()
        .post(`${API}/auth/forgot-password/verify`)
        .send({ phone, role: 'CUSTOMER', code: requested.body.data.debugCode })
        .expect(200);

      await http()
        .post(`${API}/auth/reset-password`)
        .send({
          phone,
          role: 'CUSTOMER',
          verificationToken: verified.body.data.verificationToken,
          newPassword: 'BrandNew9',
        })
        .expect(200);

      // Old sessions are gone…
      await http().post(`${API}/auth/refresh`).send({ refreshToken: tokens.refreshToken }).expect(401);

      // …and only the new password works.
      await http()
        .post(`${API}/auth/login`)
        .send({ phone, password: 'Passw0rd1', role: 'CUSTOMER' })
        .expect(401);

      await http()
        .post(`${API}/auth/login`)
        .send({ phone, password: 'BrandNew9', role: 'CUSTOMER' })
        .expect(200);
    });

    it('does not reveal whether an unknown account exists', async () => {
      const response = await http()
        .post(`${API}/auth/forgot-password`)
        .send({ phone: '012999999', role: 'CUSTOMER' })
        .expect(200);

      expect(response.body.code).toBe('OTP_SENT');
      expect(response.body.data.debugCode).toBeUndefined();
      expect(await harness.prisma.otpVerification.count()).toBe(0);
    });
  });

  describe('OTP protection', () => {
    it('rejects a wrong code and burns the challenge after too many attempts', async () => {
      const phone = '012000060';
      const registered = await http()
        .post(`${API}/auth/customer/register`)
        .send({ phone, fullName: 'Brute Force' })
        .expect(201);

      const real = registered.body.data.otp.debugCode as string;
      const wrong = real === '000000' ? '111111' : '000000';
      const payload = { identifier: phone, channel: 'SMS', purpose: 'REGISTRATION', role: 'CUSTOMER' };

      for (let attempt = 0; attempt < 4; attempt++) {
        await http().post(`${API}/auth/otp/verify`).send({ ...payload, code: wrong }).expect(400);
      }

      const final = await http()
        .post(`${API}/auth/otp/verify`)
        .send({ ...payload, code: wrong })
        .expect(400);

      expect(['OTP_MAX_ATTEMPTS_REACHED', 'OTP_EXPIRED']).toContain(final.body.code);

      // The correct code is worthless once the challenge is burnt.
      await http().post(`${API}/auth/otp/verify`).send({ ...payload, code: real }).expect(400);
    });

    it('applies a resend cooldown', async () => {
      const phone = '012000061';
      await http().post(`${API}/auth/customer/register`).send({ phone, fullName: 'Cooldown' }).expect(201);

      const response = await http()
        .post(`${API}/auth/otp/resend`)
        .send({ identifier: phone, channel: 'SMS', purpose: 'REGISTRATION', role: 'CUSTOMER' })
        .expect(429);

      expect(response.body.code).toBe('OTP_RESEND_TOO_SOON');
      expect(response.headers['retry-after']).toBeTruthy();
    });
  });
});
