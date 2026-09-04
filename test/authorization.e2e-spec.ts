import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { createTestHarness, type TestHarness } from './app-harness.js';
import { activate, http, readyDriver, type ActivatedAccount } from './helpers.js';

/**
 * Every route, checked against the access rules — not by reading the code but
 * by calling it.
 *
 * The route list comes from the running application, so an endpoint added
 * later is covered automatically: forget `@Roles`, or forget that the JWT
 * guard is global, and this fails.
 */

/** Deliberately public: health probes and the way in. */
const PUBLIC_PREFIXES = ['/health', '/api/v1/auth/'];

/** Endpoints both apps legitimately share. */
const SHARED_PREFIXES = [
  '/api/v1/mobile/uploads',
  '/api/v1/mobile/locations',
  '/api/v1/mobile/vehicle-types',
  '/api/v1/mobile/conversations',
  '/api/v1/mobile/notifications',
  '/api/v1/mobile/devices',
];

type Audience = 'public' | 'customer' | 'driver' | 'shared';

interface Route {
  method: 'get' | 'post' | 'patch' | 'put' | 'delete';
  path: string;
  audience: Audience;
}

function audienceOf(path: string): Audience {
  if (PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix))) return 'public';
  if (SHARED_PREFIXES.some((prefix) => path.startsWith(prefix))) return 'shared';
  if (path.startsWith('/api/v1/mobile/customer')) return 'customer';
  if (path.startsWith('/api/v1/mobile/driver')) return 'driver';
  return 'shared';
}

/** A syntactically valid cuid2 that belongs to nobody. */
const STRANGER_ID = 'zzzzzzzzzzzzzzzzzzzzzzzz';

function fillParams(path: string): string {
  return path
    .replace(/\{id\}/g, STRANGER_ID)
    .replace(/\{driverId\}/g, STRANGER_ID)
    .replace(/\{placeId\}/g, 'W:1')
    .replace(/\{installationId\}/g, 'INSTALL-X')
    .replace(/\{[^}]+\}/g, STRANGER_ID);
}

describe('Authorization matrix (e2e)', () => {
  let harness: TestHarness;
  let customer: ActivatedAccount;
  let driver: ActivatedAccount;
  let routes: Route[];

  beforeAll(async () => {
    harness = await createTestHarness();
    customer = await activate(harness);
    driver = await readyDriver(harness);

    const document = SwaggerModule.createDocument(
      harness.app,
      new DocumentBuilder().setTitle('audit').setVersion('1').build(),
    );

    routes = Object.entries(document.paths).flatMap(([path, operations]) =>
      Object.keys(operations as Record<string, unknown>)
        .filter((method): method is Route['method'] =>
          ['get', 'post', 'patch', 'put', 'delete'].includes(method),
        )
        .map((method) => ({ method, path, audience: audienceOf(path) })),
    );
  });

  afterAll(async () => {
    await harness.close();
  });

  const call = (route: Route, token?: string) => {
    const request = http(harness)[route.method](fillParams(route.path));
    if (token) request.set({ Authorization: `Bearer ${token}` });
    return request.send({});
  };

  it('covers every route the application exposes', () => {
    expect(routes.length).toBeGreaterThan(90);
  });

  it('refuses every protected route without a token', async () => {
    const protectedRoutes = routes.filter((route) => route.audience !== 'public');
    const leaked: string[] = [];

    for (const route of protectedRoutes) {
      const response = await call(route);
      if (response.status !== 401) {
        leaked.push(`${route.method.toUpperCase()} ${route.path} → ${response.status}`);
      }
    }

    expect(leaked, `these answered without a token:\n${leaked.join('\n')}`).toEqual([]);
  });

  it('refuses a forged token everywhere', async () => {
    const protectedRoutes = routes.filter((route) => route.audience !== 'public');
    const leaked: string[] = [];

    for (const route of protectedRoutes) {
      const response = await call(route, 'not.a.real.jwt');
      if (response.status !== 401) {
        leaked.push(`${route.method.toUpperCase()} ${route.path} → ${response.status}`);
      }
    }

    expect(leaked, `these accepted a forged token:\n${leaked.join('\n')}`).toEqual([]);
  });

  it('keeps drivers out of customer endpoints', async () => {
    const customerRoutes = routes.filter((route) => route.audience === 'customer');
    expect(customerRoutes.length).toBeGreaterThan(15);

    const leaked: string[] = [];

    for (const route of customerRoutes) {
      const response = await call(route, driver.accessToken);
      if (response.status !== 403) {
        leaked.push(`${route.method.toUpperCase()} ${route.path} → ${response.status}`);
      }
    }

    expect(leaked, `a driver reached these customer endpoints:\n${leaked.join('\n')}`).toEqual([]);
  });

  it('keeps customers out of driver endpoints', async () => {
    const driverRoutes = routes.filter((route) => route.audience === 'driver');
    expect(driverRoutes.length).toBeGreaterThan(15);

    const leaked: string[] = [];

    for (const route of driverRoutes) {
      const response = await call(route, customer.accessToken);
      if (response.status !== 403) {
        leaked.push(`${route.method.toUpperCase()} ${route.path} → ${response.status}`);
      }
    }

    expect(leaked, `a customer reached these driver endpoints:\n${leaked.join('\n')}`).toEqual([]);
  });

  it('never answers a stranger’s resource with anything but 404 or 403', async () => {
    // Every :id in these calls belongs to nobody, so a 200 would mean an
    // ownership check is missing.
    const ownedRoutes = routes.filter(
      (route) => route.path.includes('{id}') && route.audience !== 'public',
    );

    const leaked: string[] = [];

    for (const route of ownedRoutes) {
      for (const [role, token] of [
        ['customer', customer.accessToken],
        ['driver', driver.accessToken],
      ] as const) {
        const response = await call(route, token);
        // 400/422 are fine: validation or a domain rule rejected it before
        // ownership mattered. A 2xx is not.
        if (response.status < 400) {
          leaked.push(`${role} got ${response.status} from ${route.method.toUpperCase()} ${route.path}`);
        }
      }
    }

    expect(leaked, `these returned data for a resource nobody owns:\n${leaked.join('\n')}`).toEqual([]);
  });

  describe('malformed and oversized requests', () => {
    it('answers a body that is not JSON without echoing it back', async () => {
      const attempts = [
        '{"phone": "0123", internal_marker_value',
        '{"phone": broken',
        '{{{',
        'not json at all',
      ];

      for (const body of attempts) {
        const response = await http(harness)
          .post('/api/v1/auth/login')
          .set('Content-Type', 'application/json')
          .send(body)
          .expect(400);

        expect(response.body.code).toBe('VALIDATION_ERROR');
        expect(response.body.message).toBe('The request body is not valid JSON.');
        // Neither the payload nor the parser's internals come back out.
        expect(JSON.stringify(response.body)).not.toContain('internal_marker_value');
        expect(response.body.message).not.toMatch(/position|token|column/i);
      }
    });

    it('rejects an oversized body as 413 rather than a server error', async () => {
      const response = await http(harness)
        .post('/api/v1/auth/customer/register')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ phone: '012345678', fullName: 'x'.repeat(2_000_000) }))
        .expect(413);

      expect(response.body.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('still reports ordinary validation failures with their fields', async () => {
      const response = await http(harness)
        .post('/api/v1/auth/login')
        .send({ phone: 'abc' })
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(response.body.errors.length).toBeGreaterThan(0);
      expect(response.body.errors[0]).toHaveProperty('field');
    });
  });

  it('never leaks a secret in any response body', async () => {
    const forbidden = ['passwordHash', '$argon2', 'accountNumberEnc', 'codeHash', 'tokenHash', 'JWT_ACCESS_SECRET'];
    const leaked: string[] = [];

    for (const route of routes) {
      for (const token of [customer.accessToken, driver.accessToken]) {
        const response = await call(route, token);
        const body = JSON.stringify(response.body ?? {});

        for (const secret of forbidden) {
          if (body.includes(secret)) {
            leaked.push(`${route.method.toUpperCase()} ${route.path} exposed ${secret}`);
          }
        }
      }
    }

    expect(leaked, leaked.join('\n')).toEqual([]);
  });
});
