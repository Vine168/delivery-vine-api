import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './app-harness.js';
import { MaintenanceService } from '../src/modules/maintenance/maintenance.service.js';
import { OrphanedFilesService } from '../src/modules/maintenance/orphaned-files.service.js';
import { StorageService } from '../src/modules/storage/storage.service.js';
import { API, activate, completedDelivery, http, pngFixture, readyDriver, type ActivatedAccount } from './helpers.js';

const NEARBY = { latitude: 11.557, longitude: 104.929 };
const LONG_AGO = new Date(Date.now() - 400 * 86_400_000);

/**
 * Tables and buckets that only ever grew.
 *
 * Everything here deletes something, so each test also pins down what must
 * survive — an open session, a file still in use — because the failure that
 * matters is not "kept too much".
 */
describe('Retention (e2e)', () => {
  let harness: TestHarness;
  let maintenance: MaintenanceService;
  let orphans: OrphanedFilesService;
  let customer: ActivatedAccount;

  beforeAll(async () => {
    harness = await createTestHarness();
    maintenance = harness.app.get(MaintenanceService);
    orphans = harness.app.get(OrphanedFilesService);
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
    harness.map.shouldFail = false;
    customer = await activate(harness);
  });

  const asCustomer = () => ({ Authorization: `Bearer ${customer.accessToken}` });

  /** Uploads a file and returns its id — attached to nothing yet. */
  async function upload(purpose = 'PACKAGE_PHOTO'): Promise<string> {
    const response = await http(harness)
      .post(`${API}/mobile/uploads`)
      .set(asCustomer())
      .attach('file', pngFixture(), { filename: 'photo.png', contentType: 'image/png' })
      .field('purpose', purpose)
      .expect(201);

    return response.body.data.id as string;
  }

  const age = (id: string) =>
    harness.prisma.fileAsset.update({ where: { id }, data: { createdAt: LONG_AGO } });

  // ── Files ──────────────────────────────────────────────────────────────

  describe('orphaned files', () => {
    it('knows every column in the schema that points at a file', async () => {
      const references = await orphans.referencesToFileAsset();

      // Read from Postgres rather than hardcoded, so a reference added later
      // protects its files without anyone remembering to update this job.
      expect(references.length).toBeGreaterThanOrEqual(11);
      expect(references).toContainEqual({ table: '"ProofOfDelivery"', column: 'photoFileId' });
      expect(references).toContainEqual({ table: '"DriverDocument"', column: 'fileId' });
      expect(references).toContainEqual({ table: '"DeliveryPackage"', column: 'photoFileId' });
    });

    it('removes a file nothing points at, from storage as well as the table', async () => {
      const fileId = await upload();
      const asset = await harness.prisma.fileAsset.findUniqueOrThrow({ where: { id: fileId } });
      await age(fileId);

      const removed: string[] = [];
      const storage = harness.app.get(StorageService);
      const original = storage.remove.bind(storage);
      storage.remove = (async (key: string, visibility) => {
        removed.push(key);
        return original(key, visibility);
      }) as typeof storage.remove;

      try {
        const result = await orphans.sweep();
        expect(result).toMatchObject({ found: 1, removed: 1, failed: 0 });
      } finally {
        storage.remove = original;
      }

      expect(removed).toEqual([asset.objectKey]);
      expect(await harness.prisma.fileAsset.count({ where: { id: fileId } })).toBe(0);
    });

    it('leaves a file that is still in use, however old it is', async () => {
      const driver = await readyDriver(harness, NEARBY);
      const vehicleTypeId = (await harness.prisma.vehicleType.findFirstOrThrow({ select: { id: true } })).id;
      await completedDelivery(harness, customer, driver, vehicleTypeId);

      // Proof-of-delivery photos and driver documents, backdated well past the
      // grace period. Deleting one of these is the failure this job must never
      // have.
      await harness.prisma.fileAsset.updateMany({ data: { createdAt: LONG_AGO } });
      const before = await harness.prisma.fileAsset.count();
      expect(before).toBeGreaterThan(0);

      const result = await orphans.sweep();

      expect(result.found).toBe(0);
      expect(await harness.prisma.fileAsset.count()).toBe(before);
    });

    it('leaves a fresh upload alone, because a form is still being filled in', async () => {
      await upload();

      const result = await orphans.sweep();

      expect(result.found).toBe(0);
      expect(await harness.prisma.fileAsset.count()).toBe(1);
    });

    it('keeps the row when storage refuses, so the next run retries', async () => {
      const fileId = await upload();
      await age(fileId);

      const storage = harness.app.get(StorageService);
      const original = storage.remove.bind(storage);
      storage.remove = (() => Promise.reject(new Error('bucket unreachable'))) as typeof storage.remove;

      try {
        const result = await orphans.sweep();
        expect(result).toMatchObject({ found: 1, removed: 0, failed: 1 });
      } finally {
        storage.remove = original;
      }

      // The row is the only record of which object to remove; losing it would
      // leak the file invisibly and forever.
      expect(await harness.prisma.fileAsset.count({ where: { id: fileId } })).toBe(1);
    });
  });

  // ── Auth ───────────────────────────────────────────────────────────────

  describe('spent credentials', () => {
    it('removes refresh tokens long past their expiry', async () => {
      const token = await harness.prisma.refreshToken.findFirstOrThrow({
        where: { userId: customer.userId },
      });
      await harness.prisma.refreshToken.update({
        where: { id: token.id },
        data: { expiresAt: LONG_AGO },
      });

      expect(await maintenance.pruneRefreshTokens()).toBe(1);
      expect(await harness.prisma.refreshToken.count()).toBe(0);
    });

    it('keeps a token that is still valid', async () => {
      expect(await maintenance.pruneRefreshTokens()).toBe(0);
      expect(await harness.prisma.refreshToken.count()).toBe(1);
    });

    it('removes sessions that were revoked long ago', async () => {
      const session = await harness.prisma.userSession.findFirstOrThrow({
        where: { userId: customer.userId },
      });
      await harness.prisma.refreshToken.deleteMany({ where: { sessionId: session.id } });
      await harness.prisma.userSession.update({
        where: { id: session.id },
        data: { revokedAt: LONG_AGO },
      });

      expect(await maintenance.pruneSessions()).toBe(1);
    });

    it('never removes an open session, however old the row', async () => {
      await harness.prisma.userSession.updateMany({ data: { createdAt: LONG_AGO } });

      // No revokedAt means someone still has the app open.
      expect(await maintenance.pruneSessions()).toBe(0);
      expect(await harness.prisma.userSession.count()).toBe(1);
    });

    it('leaves the signed-in user able to keep working', async () => {
      await maintenance.pruneRefreshTokens();
      await maintenance.pruneSessions();

      await http(harness).get(`${API}/mobile/customer/profile`).set(asCustomer()).expect(200);
    });
  });
});
