import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './app-harness.js';
import { API, activate, adminAccount, http, nextPhone, readyDriver, type AdminAccount } from './helpers.js';

const TEAM_OPS = [
  'admin.access',
  'roles.view',
  'roles.manage',
  'admins.view',
  'admins.manage',
  'audit.view',
  'drivers.view',
  'drivers.suspend',
];

describe('Back office — roles, administrators and audit (e2e)', () => {
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
    admin = await adminAccount(harness, TEAM_OPS, { superAdmin: true });
  });

  const asAdmin = () => ({ Authorization: `Bearer ${admin.accessToken}` });

  /** Installs the permission catalogue, as the seed does on a real install. */
  async function installPermissions(): Promise<void> {
    const { PERMISSION_CATALOGUE } = await import('../src/modules/admin/permissions.catalogue.js');
    await harness.prisma.permission.createMany({ data: PERMISSION_CATALOGUE, skipDuplicates: true });
  }

  // ── Roles ──────────────────────────────────────────────────────────────

  describe('roles', () => {
    it('creates a role and grants exactly what it lists', async () => {
      await installPermissions();

      const created = await http(harness)
        .post(`${API}/admin/roles`)
        .set(asAdmin())
        .send({
          name: 'Dispatch supervisor',
          description: 'Watches the live map',
          permissions: ['admin.access', 'dashboard.view', 'deliveries.view'],
        })
        .expect(201);

      expect(created.body.data).toMatchObject({
        name: 'Dispatch supervisor',
        slug: 'dispatch-supervisor',
        isSystem: false,
        adminCount: 0,
      });
      expect(created.body.data.permissions.map((p: { code: string }) => p.code).sort()).toEqual([
        'admin.access',
        'dashboard.view',
        'deliveries.view',
      ]);

      // An operator holding it can do those things and nothing more.
      const supervisor = await http(harness)
        .post(`${API}/admin/administrators`)
        .set(asAdmin())
        .send({
          phone: nextPhone(),
          fullName: 'Chan Sopheak',
          password: 'Passw0rd1',
          roleId: created.body.data.id,
        })
        .expect(201);

      const session = await http(harness)
        .post(`${API}/auth/login`)
        .send({ phone: supervisor.body.data.phone, password: 'Passw0rd1', role: 'ADMIN' })
        .expect(200);

      const token = { Authorization: `Bearer ${session.body.data.tokens.accessToken}` };
      await http(harness).get(`${API}/admin/dashboard`).set(token).expect(200);
      await http(harness).get(`${API}/admin/roles`).set(token).expect(403);
    });

    it('refuses a permission the platform does not recognise', async () => {
      await installPermissions();

      const response = await http(harness)
        .post(`${API}/admin/roles`)
        .set(asAdmin())
        .send({ name: 'Invented', permissions: ['admin.access', 'deliveries.teleport'] })
        .expect(422);

      expect(response.body.code).toBe('PERMISSION_NOT_FOUND');
      expect(response.body.message).toContain('deliveries.teleport');
    });

    it('drops the cached access of everyone holding a role it changes', async () => {
      await installPermissions();

      const role = await http(harness)
        .post(`${API}/admin/roles`)
        .set(asAdmin())
        .send({ name: 'Support desk', permissions: ['admin.access', 'deliveries.view'] })
        .expect(201);

      const operator = await http(harness)
        .post(`${API}/admin/administrators`)
        .set(asAdmin())
        .send({
          phone: nextPhone(),
          fullName: 'Support Person',
          password: 'Passw0rd1',
          roleId: role.body.data.id,
        })
        .expect(201);

      const session = await http(harness)
        .post(`${API}/auth/login`)
        .send({ phone: operator.body.data.phone, password: 'Passw0rd1', role: 'ADMIN' })
        .expect(200);
      const token = { Authorization: `Bearer ${session.body.data.tokens.accessToken}` };

      await http(harness).get(`${API}/admin/deliveries`).set(token).expect(200);

      // Take the permission away while they hold a live token.
      await http(harness)
        .patch(`${API}/admin/roles/${role.body.data.id}`)
        .set(asAdmin())
        .send({ permissions: ['admin.access'] })
        .expect(200);

      // Refused at once — not when a cache happens to expire.
      await http(harness).get(`${API}/admin/deliveries`).set(token).expect(403);
      await http(harness).get(`${API}/admin/me`).set(token).expect(200);
    });

    it('will not change or delete a system role', async () => {
      await installPermissions();
      const system = await harness.prisma.role.create({
        data: { name: 'Operations', slug: 'operations', isSystem: true },
      });

      const update = await http(harness)
        .patch(`${API}/admin/roles/${system.id}`)
        .set(asAdmin())
        .send({ name: 'Operations (edited)' })
        .expect(403);
      expect(update.body.code).toBe('ROLE_IS_SYSTEM');

      const remove = await http(harness).delete(`${API}/admin/roles/${system.id}`).set(asAdmin()).expect(403);
      expect(remove.body.code).toBe('ROLE_IS_SYSTEM');
    });

    it('will not delete a role somebody holds', async () => {
      await installPermissions();
      const role = await http(harness)
        .post(`${API}/admin/roles`)
        .set(asAdmin())
        .send({ name: 'Temporary', permissions: ['admin.access'] })
        .expect(201);

      await http(harness)
        .post(`${API}/admin/administrators`)
        .set(asAdmin())
        .send({
          phone: nextPhone(),
          fullName: 'Holder',
          password: 'Passw0rd1',
          roleId: role.body.data.id,
        })
        .expect(201);

      const response = await http(harness)
        .delete(`${API}/admin/roles/${role.body.data.id}`)
        .set(asAdmin())
        .expect(409);

      expect(response.body.code).toBe('ROLE_IN_USE');
      expect(response.body.message).toContain('1 operator');
    });
  });

  // ── Administrators ─────────────────────────────────────────────────────

  describe('administrators', () => {
    it('never returns a password or its hash', async () => {
      await installPermissions();
      const role = await http(harness)
        .post(`${API}/admin/roles`)
        .set(asAdmin())
        .send({ name: 'Finance desk', permissions: ['admin.access', 'finance.view'] })
        .expect(201);

      const created = await http(harness)
        .post(`${API}/admin/administrators`)
        .set(asAdmin())
        .send({
          phone: nextPhone(),
          fullName: 'Sok Dara',
          email: 'dara@roktenh.com',
          password: 'S3cretPassw0rd',
          roleId: role.body.data.id,
        })
        .expect(201);

      const body = JSON.stringify(created.body);
      expect(body).not.toContain('S3cretPassw0rd');
      expect(body).not.toContain('passwordHash');
      expect(body).not.toContain('$argon2');

      expect(created.body.data).toMatchObject({
        fullName: 'Sok Dara',
        roleName: 'Finance desk',
        isSuperAdmin: false,
        permissionCount: 2,
        status: 'ACTIVE',
      });

      const listed = await http(harness).get(`${API}/admin/administrators`).set(asAdmin()).expect(200);
      expect(JSON.stringify(listed.body)).not.toContain('passwordHash');
    });

    it('refuses a phone number that already has a back-office account', async () => {
      await installPermissions();
      const role = await harness.prisma.role.findFirstOrThrow({ select: { id: true } });

      const response = await http(harness)
        .post(`${API}/admin/administrators`)
        .set(asAdmin())
        .send({ phone: admin.phone, fullName: 'Impostor', password: 'Passw0rd1', roleId: role.id })
        .expect(409);

      expect(response.body.code).toBe('ACCOUNT_ALREADY_EXISTS');
    });

    it('lets the same phone hold a driver account and a back-office account', async () => {
      await installPermissions();
      const phone = nextPhone();
      const driver = await readyDriver(harness, { latitude: 11.557, longitude: 104.929 }, phone);
      const role = await harness.prisma.role.findFirstOrThrow({ select: { id: true } });

      await http(harness)
        .post(`${API}/admin/administrators`)
        .set(asAdmin())
        .send({ phone, fullName: 'Also an operator', password: 'Passw0rd1', roleId: role.id })
        .expect(201);

      // Both sign in, each into their own account.
      await http(harness)
        .post(`${API}/auth/login`)
        .send({ phone, password: 'Passw0rd1', role: 'ADMIN' })
        .expect(200);
      await http(harness)
        .post(`${API}/auth/login`)
        .send({ phone, password: 'Passw0rd1', role: 'DRIVER' })
        .expect(200);

      expect(driver.driverId).toBeTruthy();
    });

    it('resets a password and ends the operator’s sessions', async () => {
      await installPermissions();
      const role = await harness.prisma.role.findFirstOrThrow({ select: { id: true } });
      const operator = await http(harness)
        .post(`${API}/admin/administrators`)
        .set(asAdmin())
        .send({ phone: nextPhone(), fullName: 'Forgetful', password: 'Passw0rd1', roleId: role.id })
        .expect(201);

      const session = await http(harness)
        .post(`${API}/auth/login`)
        .send({ phone: operator.body.data.phone, password: 'Passw0rd1', role: 'ADMIN' })
        .expect(200);
      const token = { Authorization: `Bearer ${session.body.data.tokens.accessToken}` };
      await http(harness).get(`${API}/admin/me`).set(token).expect(200);

      await http(harness)
        .post(`${API}/admin/administrators/${operator.body.data.id}/reset-password`)
        .set(asAdmin())
        .send({ password: 'N3wPassw0rd!' })
        .expect(200);

      // The old token is dead and the old password no longer works.
      await http(harness).get(`${API}/admin/me`).set(token).expect(401);
      await http(harness)
        .post(`${API}/auth/login`)
        .send({ phone: operator.body.data.phone, password: 'Passw0rd1', role: 'ADMIN' })
        .expect(401);
      await http(harness)
        .post(`${API}/auth/login`)
        .send({ phone: operator.body.data.phone, password: 'N3wPassw0rd!', role: 'ADMIN' })
        .expect(200);

      // And the new password is nowhere in the audit trail.
      const audit = await harness.prisma.auditLog.findFirstOrThrow({
        where: { action: 'admin.password.reset' },
      });
      expect(JSON.stringify(audit)).not.toContain('N3wPassw0rd');
    });
  });

  // ── Escalation and lockout ─────────────────────────────────────────────

  describe('safeguards', () => {
    it('will not let a non-super-admin grant unrestricted access', async () => {
      await installPermissions();
      const manager = await adminAccount(harness, ['admin.access', 'admins.view', 'admins.manage']);
      const role = await harness.prisma.role.findFirstOrThrow({ select: { id: true } });

      const target = await http(harness)
        .post(`${API}/admin/administrators`)
        .set({ Authorization: `Bearer ${manager.accessToken}` })
        .send({ phone: nextPhone(), fullName: 'Ally', password: 'Passw0rd1', roleId: role.id })
        .expect(201);

      const response = await http(harness)
        .patch(`${API}/admin/administrators/${target.body.data.id}`)
        .set({ Authorization: `Bearer ${manager.accessToken}` })
        .send({ isSuperAdmin: true })
        .expect(403);

      expect(response.body.code).toBe('SUPER_ADMIN_REQUIRED');

      const after = await harness.prisma.adminProfile.findUniqueOrThrow({
        where: { id: target.body.data.id },
      });
      expect(after.isSuperAdmin).toBe(false);
    });

    it('will not let an operator promote themselves', async () => {
      await installPermissions();
      const manager = await adminAccount(harness, ['admin.access', 'admins.view', 'admins.manage']);
      const profile = await harness.prisma.adminProfile.findFirstOrThrow({
        where: { userId: manager.userId },
      });

      const response = await http(harness)
        .patch(`${API}/admin/administrators/${profile.id}`)
        .set({ Authorization: `Bearer ${manager.accessToken}` })
        .send({ isSuperAdmin: true })
        .expect(403);

      expect(response.body.code).toBe('SUPER_ADMIN_REQUIRED');
    });

    it('will not let a super admin change their own role or suspend themselves', async () => {
      await installPermissions();
      const own = await harness.prisma.adminProfile.findFirstOrThrow({ where: { userId: admin.userId } });
      const other = await http(harness)
        .post(`${API}/admin/roles`)
        .set(asAdmin())
        .send({ name: 'Nothing much', permissions: ['admin.access'] })
        .expect(201);

      const demote = await http(harness)
        .patch(`${API}/admin/administrators/${own.id}`)
        .set(asAdmin())
        .send({ roleId: other.body.data.id })
        .expect(403);
      expect(demote.body.code).toBe('CANNOT_MODIFY_SELF');

      const suspend = await http(harness)
        .post(`${API}/admin/administrators/${own.id}/suspend`)
        .set(asAdmin())
        .send({ reason: 'Testing' })
        .expect(403);
      expect(suspend.body.code).toBe('CANNOT_MODIFY_SELF');
    });

    it('keeps at least one super admin', async () => {
      await installPermissions();
      const second = await adminAccount(harness, ['admin.access', 'admins.manage'], { superAdmin: true });
      const first = await harness.prisma.adminProfile.findFirstOrThrow({ where: { userId: admin.userId } });

      // While there are two, demoting one is fine.
      await http(harness)
        .patch(`${API}/admin/administrators/${first.id}`)
        .set({ Authorization: `Bearer ${second.accessToken}` })
        .send({ isSuperAdmin: false })
        .expect(200);

      // Now the second is the only one left.
      const secondProfile = await harness.prisma.adminProfile.findFirstOrThrow({
        where: { userId: second.userId },
      });
      const response = await http(harness)
        .post(`${API}/admin/administrators/${secondProfile.id}/suspend`)
        .set(asAdmin())
        .send({ reason: 'Testing' })
        .expect(409);

      expect(response.body.code).toBe('LAST_SUPER_ADMIN');
    });

    it('suspends an operator and ends their sessions at once', async () => {
      await installPermissions();
      const role = await harness.prisma.role.findFirstOrThrow({ select: { id: true } });
      const operator = await http(harness)
        .post(`${API}/admin/administrators`)
        .set(asAdmin())
        .send({ phone: nextPhone(), fullName: 'Leaver', password: 'Passw0rd1', roleId: role.id })
        .expect(201);

      const session = await http(harness)
        .post(`${API}/auth/login`)
        .send({ phone: operator.body.data.phone, password: 'Passw0rd1', role: 'ADMIN' })
        .expect(200);
      const token = { Authorization: `Bearer ${session.body.data.tokens.accessToken}` };

      await http(harness)
        .post(`${API}/admin/administrators/${operator.body.data.id}/suspend`)
        .set(asAdmin())
        .send({ reason: 'Left the company' })
        .expect(200);

      await http(harness).get(`${API}/admin/me`).set(token).expect(401);
      const login = await http(harness)
        .post(`${API}/auth/login`)
        .send({ phone: operator.body.data.phone, password: 'Passw0rd1', role: 'ADMIN' })
        .expect(403);
      expect(login.body.code).toBe('ACCOUNT_SUSPENDED');

      await http(harness)
        .post(`${API}/admin/administrators/${operator.body.data.id}/reinstate`)
        .set(asAdmin())
        .expect(200);
      await http(harness)
        .post(`${API}/auth/login`)
        .send({ phone: operator.body.data.phone, password: 'Passw0rd1', role: 'ADMIN' })
        .expect(200);
    });
  });

  // ── Audit log ──────────────────────────────────────────────────────────

  describe('GET /admin/audit-logs', () => {
    it('records what was done, by whom, with the values on both sides', async () => {
      const driver = await readyDriver(harness, { latitude: 11.557, longitude: 104.929 });

      await http(harness)
        .post(`${API}/admin/drivers/${driver.driverId}/suspend`)
        .set(asAdmin())
        .send({ reason: 'Documents found to be forged' })
        .expect(200);

      const response = await http(harness).get(`${API}/admin/audit-logs`).set(asAdmin()).expect(200);

      const entry = response.body.data.find((row: { action: string }) => row.action === 'driver.suspend');
      expect(entry).toMatchObject({
        entityType: 'DriverProfile',
        entityId: driver.driverId,
        actorUserId: admin.userId,
        actorName: 'Ops Operator',
      });
      expect(entry.summary).toContain('forged');
      expect(entry.before).toMatchObject({ approvalStatus: 'ACTIVE' });
      expect(entry.after).toMatchObject({ approvalStatus: 'SUSPENDED' });
      expect(entry.ipAddress).toBeTruthy();
    });

    it('filters by entity and by action', async () => {
      await installPermissions();
      const customer = await activate(harness);
      const driver = await readyDriver(harness, { latitude: 11.557, longitude: 104.929 });

      await http(harness)
        .post(`${API}/admin/drivers/${driver.driverId}/suspend`)
        .set(asAdmin())
        .send({ reason: 'One' })
        .expect(200);
      await http(harness)
        .post(`${API}/admin/roles`)
        .set(asAdmin())
        .send({ name: 'Another role', permissions: ['admin.access'] })
        .expect(201);

      const byEntity = await http(harness)
        .get(`${API}/admin/audit-logs?entityType=DriverProfile&entityId=${driver.driverId}`)
        .set(asAdmin())
        .expect(200);
      expect(byEntity.body.data).toHaveLength(1);
      expect(byEntity.body.data[0].action).toBe('driver.suspend');

      const byAction = await http(harness)
        .get(`${API}/admin/audit-logs?action=role.`)
        .set(asAdmin())
        .expect(200);
      expect(byAction.body.data).toHaveLength(1);
      expect(byAction.body.data[0].action).toBe('role.create');

      expect(customer.customerId).toBeTruthy();
    });

    it('is refused to an operator without the audit permission', async () => {
      const operator = await adminAccount(harness, ['admin.access', 'drivers.view']);

      await http(harness)
        .get(`${API}/admin/audit-logs`)
        .set({ Authorization: `Bearer ${operator.accessToken}` })
        .expect(403);
    });
  });
});
