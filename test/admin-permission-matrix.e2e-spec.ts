import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Reflector } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './app-harness.js';
import { PERMISSIONS_KEY } from '../src/modules/admin/require-permissions.decorator.js';
import {
  PERMISSION_CATALOGUE,
  PERMISSIONS_BY_CODE,
  SYSTEM_ROLES,
} from '../src/modules/admin/permissions.catalogue.js';
import { activate, adminAccount, http, readyDriver, type AdminAccount } from './helpers.js';

const ADMIN_PREFIX = '/api/v1/admin';

/** A syntactically valid cuid2 that belongs to nobody. */
const STRANGER_ID = 'zzzzzzzzzzzzzzzzzzzzzzzz';

interface AdminRoute {
  method: 'get' | 'post' | 'patch' | 'put' | 'delete';
  path: string;
  permissions: string[];
}

function fillParams(path: string): string {
  return path
    .replace(/\{key\}/g, 'matching.radiusMeters')
    .replace(/\{documentId\}/g, STRANGER_ID)
    .replace(/\{[^}]+\}/g, STRANGER_ID);
}

/**
 * The back office, checked as a whole rather than endpoint by endpoint.
 *
 * The route list comes from the running application and the permission each
 * one declares comes from its own metadata, so an admin endpoint added later
 * is covered automatically: forget `@RequirePermissions`, invent a permission
 * code, or add a permission to the catalogue that no endpoint ever checks, and
 * one of these fails.
 */
describe('Back office — permission matrix (e2e)', () => {
  let harness: TestHarness;
  let routes: AdminRoute[];
  let superAdmin: AdminAccount;
  let powerless: AdminAccount;

  beforeAll(async () => {
    harness = await createTestHarness();

    const document = SwaggerModule.createDocument(
      harness.app,
      new DocumentBuilder().setTitle('audit').setVersion('1').build(),
    );

    // The declared permission is metadata on the handler, not something the
    // OpenAPI document carries, so it is read back off the route itself.
    const reflector = harness.app.get(Reflector);
    const server = harness.app.getHttpAdapter().getInstance() as {
      router?: { stack: unknown[] };
      _router?: { stack: unknown[] };
    };
    const stack = (server.router ?? server._router)?.stack ?? [];

    const declared = new Map<string, string[]>();
    for (const layer of stack as {
      route?: { path: string; stack: { method?: string; handle?: unknown }[]; methods: Record<string, boolean> };
    }[]) {
      if (!layer.route) continue;
      const handler = (layer.route.stack.at(-1) as { handle?: unknown })?.handle;
      if (typeof handler !== 'function') continue;

      const permissions = reflector.get<string[]>(PERMISSIONS_KEY, handler as never);
      if (!permissions) continue;

      for (const method of Object.keys(layer.route.methods)) {
        declared.set(`${method}:${layer.route.path}`, permissions);
      }
    }

    routes = Object.entries(document.paths)
      .filter(([path]) => path.startsWith(ADMIN_PREFIX))
      .flatMap(([path, operations]) =>
        Object.keys(operations as Record<string, unknown>)
          .filter((method): method is AdminRoute['method'] =>
            ['get', 'post', 'patch', 'put', 'delete'].includes(method),
          )
          .map((method) => ({
            method,
            path,
            permissions: declared.get(`${method}:${path.replace(/\{(\w+)\}/g, ':$1')}`) ?? [],
          })),
      );

    await harness.reset();
    superAdmin = await adminAccount(harness, ['admin.access'], { superAdmin: true });
    // A real account with a real role that grants only the ability to sign in.
    powerless = await adminAccount(harness, ['admin.access']);
  });

  afterAll(async () => {
    await harness.close();
  });

  const call = (route: AdminRoute, token?: string) => {
    const request = http(harness)[route.method](fillParams(route.path));
    if (token) request.set({ Authorization: `Bearer ${token}` });
    return request.send({});
  };

  // ── Structure ──────────────────────────────────────────────────────────

  describe('structure', () => {
    it('exposes a substantial back office', () => {
      expect(routes.length).toBeGreaterThan(45);
    });

    it('declares a permission on every admin endpoint', () => {
      const undeclared = routes
        .filter((route) => route.permissions.length === 0)
        .map((route) => `${route.method.toUpperCase()} ${route.path}`);

      expect(
        undeclared,
        `these admin endpoints declare no permission:\n${undeclared.join('\n')}`,
      ).toEqual([]);
    });

    it('only ever requires permissions the catalogue defines', () => {
      const invented = routes
        .flatMap((route) =>
          route.permissions
            .filter((code) => !PERMISSIONS_BY_CODE.has(code))
            .map((code) => `${route.method.toUpperCase()} ${route.path} → ${code}`),
        );

      expect(invented, `these require permissions nobody can hold:\n${invented.join('\n')}`).toEqual([]);
    });

    it('has no permission in the catalogue that nothing checks', () => {
      const checked = new Set(routes.flatMap((route) => route.permissions));
      const unused = PERMISSION_CATALOGUE.map((permission) => permission.code).filter(
        (code) => !checked.has(code),
      );

      // A permission nothing checks is a checkbox in the role editor that
      // grants nothing — worse than a missing feature, because it reads as one
      // that exists.
      expect(unused, `these permissions are never required by any endpoint:\n${unused.join('\n')}`).toEqual(
        [],
      );
    });

    it('builds system roles only from real permissions', () => {
      const invented = SYSTEM_ROLES.flatMap((role) =>
        role.permissions.filter((code) => !PERMISSIONS_BY_CODE.has(code)).map((code) => `${role.name}: ${code}`),
      );

      expect(invented).toEqual([]);
    });

    it('gives every system role the ability to sign in at all', () => {
      const cannotSignIn = SYSTEM_ROLES.filter((role) => !role.permissions.includes('admin.access')).map(
        (role) => role.name,
      );

      expect(cannotSignIn, `these roles could not open the back office:\n${cannotSignIn}`).toEqual([]);
    });
  });

  // ── Enforcement ────────────────────────────────────────────────────────

  describe('enforcement', () => {
    it('refuses every admin endpoint without a token', async () => {
      const leaked: string[] = [];

      for (const route of routes) {
        const response = await call(route);
        if (response.status !== 401) {
          leaked.push(`${route.method.toUpperCase()} ${route.path} → ${response.status}`);
        }
      }

      expect(leaked, `these answered without a token:\n${leaked.join('\n')}`).toEqual([]);
    });

    it('refuses every admin endpoint to a customer and to a driver', async () => {
      const customer = await activate(harness);
      const driver = await readyDriver(harness);
      const leaked: string[] = [];

      for (const route of routes) {
        for (const [who, token] of [
          ['customer', customer.accessToken],
          ['driver', driver.accessToken],
        ] as const) {
          const response = await call(route, token);
          if (response.status !== 403) {
            leaked.push(`${who}: ${route.method.toUpperCase()} ${route.path} → ${response.status}`);
          }
        }
      }

      expect(leaked, `mobile accounts reached these:\n${leaked.join('\n')}`).toEqual([]);
    });

    it('refuses an operator who holds nothing but the right to sign in', async () => {
      // Everything except the two endpoints that exist precisely to tell an
      // operator who they are.
      const gated = routes.filter((route) => !route.permissions.includes('admin.access'));
      expect(gated.length).toBeGreaterThan(40);

      const leaked: string[] = [];

      for (const route of gated) {
        const response = await call(route, powerless.accessToken);
        if (response.status !== 403) {
          leaked.push(`${route.method.toUpperCase()} ${route.path} → ${response.status}`);
        }
      }

      expect(leaked, `an operator with no permissions reached these:\n${leaked.join('\n')}`).toEqual([]);
    });

    it('lets a super admin past every permission check', async () => {
      const refused: string[] = [];

      for (const route of routes) {
        const response = await call(route, superAdmin.accessToken);
        // 404s and validation errors are fine — they mean the request got past
        // authorization and failed on its own merits.
        if (response.status === 403) {
          refused.push(`${route.method.toUpperCase()} ${route.path}`);
        }
      }

      expect(refused, `a super admin was refused these:\n${refused.join('\n')}`).toEqual([]);
    });

    it('names the module and action it refused, never a bare "forbidden"', async () => {
      const sample = routes.find((route) => route.permissions.includes('deliveries.cancel'));
      expect(sample).toBeDefined();

      const response = await call(sample as AdminRoute, powerless.accessToken);

      expect(response.status).toBe(403);
      expect(response.body.message).toMatch(/permission to cancel deliveries/i);
    });

    it('refuses an ADMIN account with no back-office profile at all', async () => {
      const { PasswordService } = await import('../src/modules/auth/services/password.service.js');
      const passwordHash = await harness.app.get(PasswordService).hash('Passw0rd1');

      await harness.prisma.user.create({
        data: {
          phone: '+855999000111',
          role: 'ADMIN',
          status: 'ACTIVE',
          passwordHash,
          phoneVerifiedAt: new Date(),
        },
      });

      const session = await http(harness)
        .post('/api/v1/auth/login')
        .send({ phone: '0999000111', password: 'Passw0rd1', role: 'ADMIN' })
        .expect(200);

      const response = await http(harness)
        .get(`${ADMIN_PREFIX}/me`)
        .set({ Authorization: `Bearer ${session.body.data.tokens.accessToken}` })
        .expect(403);

      expect(response.body.message).toContain('no back-office profile');
    });
  });

  // ── Documentation ──────────────────────────────────────────────────────

  describe('documentation', () => {
    it('documents every admin endpoint with a summary and bearer auth', () => {
      const document = SwaggerModule.createDocument(
        harness.app,
        new DocumentBuilder().setTitle('audit').setVersion('1').addBearerAuth().build(),
      );

      const undocumented: string[] = [];

      for (const [path, operations] of Object.entries(document.paths)) {
        if (!path.startsWith(ADMIN_PREFIX)) continue;

        for (const [method, operation] of Object.entries(operations as Record<string, unknown>)) {
          if (!['get', 'post', 'patch', 'put', 'delete'].includes(method)) continue;
          const spec = operation as { summary?: string; tags?: string[]; security?: unknown[] };

          if (!spec.summary) undocumented.push(`${method.toUpperCase()} ${path}: no summary`);
          if (!spec.tags?.length) undocumented.push(`${method.toUpperCase()} ${path}: no tag`);
          if (!spec.security?.length) undocumented.push(`${method.toUpperCase()} ${path}: no bearer auth`);
        }
      }

      expect(undocumented, undocumented.join('\n')).toEqual([]);
    });

    it('groups the back office under its own tags', () => {
      const document = SwaggerModule.createDocument(
        harness.app,
        new DocumentBuilder().setTitle('audit').setVersion('1').build(),
      );

      const tags = new Set(
        Object.entries(document.paths)
          .filter(([path]) => path.startsWith(ADMIN_PREFIX))
          .flatMap(([, operations]) =>
            Object.values(operations as Record<string, { tags?: string[] }>).flatMap(
              (operation) => operation.tags ?? [],
            ),
          ),
      );

      // Every admin tag is an admin tag; nothing leaks into the mobile groups.
      expect([...tags].every((tag) => tag.startsWith('Admin'))).toBe(true);
      expect(tags.size).toBeGreaterThan(6);
    });
  });
});
