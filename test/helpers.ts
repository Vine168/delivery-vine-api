import request from 'supertest';
import type { TestHarness } from './app-harness.js';

export const API = '/api/v1';

export interface ActivatedAccount {
  accessToken: string;
  refreshToken: string;
  userId: string;
  customerId: string | null;
  driverId: string | null;
  phone: string;
}

let phoneCounter = 0;

/** A phone number no other test in this file has used. */
export function nextPhone(): string {
  phoneCounter += 1;
  return `012${String(phoneCounter).padStart(6, '0')}`;
}

export function http(harness: TestHarness): request.Agent {
  return request(harness.app.getHttpServer() as Parameters<typeof request>[0]);
}

/**
 * Registers, verifies the OTP and sets a password — the shortest path to an
 * account a test can actually use. Rate-limit counters live in Redis and are
 * flushed by `harness.reset()`, so this is safe to call repeatedly.
 */
export async function activate(
  harness: TestHarness,
  role: 'CUSTOMER' | 'DRIVER' = 'CUSTOMER',
  phone = nextPhone(),
): Promise<ActivatedAccount> {
  const path = role === 'CUSTOMER' ? 'customer' : 'driver';
  const agent = http(harness);

  const registered = await agent
    .post(`${API}/auth/${path}/register`)
    .send({ phone, fullName: role === 'CUSTOMER' ? 'Sok Dara' : 'Chan Sopheak' })
    .expect(201);

  const verified = await agent
    .post(`${API}/auth/otp/verify`)
    .send({
      identifier: phone,
      channel: 'SMS',
      purpose: 'REGISTRATION',
      role,
      code: registered.body.data.otp.debugCode,
    })
    .expect(200);

  const session = await agent
    .post(`${API}/auth/${path}/set-password`)
    .send({ phone, verificationToken: verified.body.data.verificationToken, password: 'Passw0rd1' })
    .expect(200);

  return {
    accessToken: session.body.data.tokens.accessToken,
    refreshToken: session.body.data.tokens.refreshToken,
    userId: session.body.data.user.id,
    customerId: session.body.data.user.customerId,
    driverId: session.body.data.user.driverId,
    phone,
  };
}

/** An 8×8 teal PNG — small, and a genuinely valid image. */
export function pngFixture(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAG0lEQVQoz2NkYPjPQApgYhgFo2BwAcbRhAcAaOgBAcBTGvsAAAAASUVORK5CYII=',
    'base64',
  );
}

/** Bytes that are not any format we accept, whatever they are named. */
export function scriptFixture(): Buffer {
  return Buffer.from('<?php system($_GET["cmd"]); ?>\n'.repeat(4));
}
