import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './app-harness.js';
import { API, activate, http, pngFixture, scriptFixture } from './helpers.js';

describe('Profiles, addresses, uploads and driver onboarding (e2e)', () => {
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

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Returns the supertest chain so callers can add their own `.expect(...)`. */
  function uploadPng(token: string, purpose: string) {
    return http(harness)
      .post(`${API}/mobile/uploads`)
      .set(auth(token))
      .attach('file', pngFixture(), { filename: 'photo.png', contentType: 'image/png' })
      .field('purpose', purpose);
  }

  describe('customer profile', () => {
    it('returns the profile with counters at zero for a new account', async () => {
      const customer = await activate(harness);

      const response = await http(harness)
        .get(`${API}/mobile/customer/profile`)
        .set(auth(customer.accessToken))
        .expect(200);

      expect(response.body.code).toBe('PROFILE_FETCHED');
      expect(response.body.data).toMatchObject({
        fullName: 'Sok Dara',
        phone: customer.phone.replace(/^0/, '+855'),
        status: 'ACTIVE',
        phoneVerified: true,
        avatarUrl: null,
      });
      expect(response.body.data.stats).toEqual({
        totalDeliveries: 0,
        completedDeliveries: 0,
        activeDeliveries: 0,
        savedAddresses: 0,
      });
    });

    it('updates the name and email', async () => {
      const customer = await activate(harness);

      const response = await http(harness)
        .patch(`${API}/mobile/customer/profile`)
        .set(auth(customer.accessToken))
        .send({ fullName: 'Sok Dara Jr', email: 'DARA@Example.COM ' })
        .expect(200);

      expect(response.body.data.fullName).toBe('Sok Dara Jr');
      expect(response.body.data.email).toBe('dara@example.com');
    });

    it('refuses an email another customer already uses', async () => {
      const first = await activate(harness);
      const second = await activate(harness);

      await http(harness)
        .patch(`${API}/mobile/customer/profile`)
        .set(auth(first.accessToken))
        .send({ email: 'shared@example.com' })
        .expect(200);

      const response = await http(harness)
        .patch(`${API}/mobile/customer/profile`)
        .set(auth(second.accessToken))
        .send({ email: 'shared@example.com' })
        .expect(409);

      expect(response.body.code).toBe('CONFLICT');
    });

    it('deletes the account and frees the phone number for re-registration', async () => {
      const customer = await activate(harness);

      await http(harness).delete(`${API}/mobile/customer/account`).set(auth(customer.accessToken)).expect(204);

      // The session is dead.
      await http(harness).get(`${API}/mobile/customer/profile`).set(auth(customer.accessToken)).expect(401);

      // And the number can be registered again — after the OTP cooldown that
      // any repeat request for the same number is subject to.
      await harness.expireOtpCooldowns();
      await http(harness)
        .post(`${API}/auth/customer/register`)
        .send({ phone: customer.phone, fullName: 'Someone Else' })
        .expect(201);
    });
  });

  describe('uploads', () => {
    it('stores a real image and returns a working URL', async () => {
      const customer = await activate(harness);

      const response = await uploadPng(customer.accessToken, 'CUSTOMER_AVATAR').expect(201);

      expect(response.body.code).toBe('FILE_UPLOADED');
      expect(response.body.data).toMatchObject({
        purpose: 'CUSTOMER_AVATAR',
        visibility: 'PUBLIC',
        mimeType: 'image/png',
      });
      expect(response.body.data.url).toContain('deliver-public');
      expect(response.body.data.urlExpiresAt).toBeNull();
    });

    it('identifies files by content, not by the declared type', async () => {
      const customer = await activate(harness);

      const response = await http(harness)
        .post(`${API}/mobile/uploads`)
        .set(auth(customer.accessToken))
        .attach('file', scriptFixture(), { filename: 'avatar.png', contentType: 'image/png' })
        .field('purpose', 'CUSTOMER_AVATAR')
        .expect(415);

      expect(response.body.code).toBe('FILE_TYPE_NOT_ALLOWED');
    });

    it('refuses a purpose the caller role cannot use', async () => {
      const customer = await activate(harness);

      const response = await uploadPng(customer.accessToken, 'DRIVER_DOCUMENT').expect(403);
      expect(response.body.code).toBe('ROLE_NOT_ALLOWED');
    });

    it('gives private files an expiring URL and public files a stable one', async () => {
      const driver = await activate(harness, 'DRIVER');

      const privateFile = await uploadPng(driver.accessToken, 'DRIVER_DOCUMENT').expect(201);
      expect(privateFile.body.data.visibility).toBe('PRIVATE');
      expect(privateFile.body.data.urlExpiresAt).toBeTruthy();
      expect(privateFile.body.data.url).toContain('X-Amz-Signature');

      const publicFile = await uploadPng(driver.accessToken, 'DRIVER_AVATAR').expect(201);
      expect(publicFile.body.data.url).not.toContain('X-Amz-Signature');
    });

    it('will not hand one user another user’s file', async () => {
      const owner = await activate(harness);
      const stranger = await activate(harness);

      const uploaded = await uploadPng(owner.accessToken, 'CUSTOMER_AVATAR').expect(201);

      await http(harness)
        .get(`${API}/mobile/uploads/${uploaded.body.data.id}`)
        .set(auth(stranger.accessToken))
        .expect(404);
    });

    it('will not let a customer attach a file they do not own as their avatar', async () => {
      const owner = await activate(harness);
      const attacker = await activate(harness);

      const uploaded = await uploadPng(owner.accessToken, 'CUSTOMER_AVATAR').expect(201);

      const response = await http(harness)
        .post(`${API}/mobile/customer/profile/avatar`)
        .set(auth(attacker.accessToken))
        .send({ fileId: uploaded.body.data.id })
        .expect(400);

      expect(response.body.code).toBe('FILE_NOT_FOUND');
    });

    it('attaches an avatar and exposes it on the profile', async () => {
      const customer = await activate(harness);
      const uploaded = await uploadPng(customer.accessToken, 'CUSTOMER_AVATAR').expect(201);

      const updated = await http(harness)
        .post(`${API}/mobile/customer/profile/avatar`)
        .set(auth(customer.accessToken))
        .send({ fileId: uploaded.body.data.id })
        .expect(200);

      expect(updated.body.code).toBe('AVATAR_UPDATED');
      expect(updated.body.data.avatarUrl).toContain('deliver-public');
    });
  });

  describe('addresses', () => {
    const address = {
      label: 'HOME',
      addressLine: 'St. 271, Boeng Keng Kang, Phnom Penh',
      latitude: 11.5564,
      longitude: 104.9282,
      contactName: 'Sok Dara',
      contactPhone: '012345678',
    };

    it('makes the first saved address the default', async () => {
      const customer = await activate(harness);

      const first = await http(harness)
        .post(`${API}/mobile/customer/addresses`)
        .set(auth(customer.accessToken))
        .send({ ...address, isDefault: false })
        .expect(201);

      expect(first.body.data.isDefault).toBe(true);
      expect(first.body.data.contactPhone).toBe('+85512345678');
    });

    it('moves the default and leaves exactly one', async () => {
      const customer = await activate(harness);
      const agent = http(harness);

      await agent.post(`${API}/mobile/customer/addresses`).set(auth(customer.accessToken)).send(address).expect(201);
      const second = await agent
        .post(`${API}/mobile/customer/addresses`)
        .set(auth(customer.accessToken))
        .send({ ...address, label: 'OFFICE', addressLine: 'Aeon Mall 1' })
        .expect(201);

      await agent
        .patch(`${API}/mobile/customer/addresses/${second.body.data.id}/default`)
        .set(auth(customer.accessToken))
        .expect(200);

      const list = await agent.get(`${API}/mobile/customer/addresses`).set(auth(customer.accessToken)).expect(200);

      expect(list.body.data.filter((a: { isDefault: boolean }) => a.isDefault)).toHaveLength(1);
      expect(list.body.data[0].id).toBe(second.body.data.id); // default comes first
    });

    it('promotes another address when the default is deleted', async () => {
      const customer = await activate(harness);
      const agent = http(harness);

      const first = await agent
        .post(`${API}/mobile/customer/addresses`)
        .set(auth(customer.accessToken))
        .send(address)
        .expect(201);
      await agent
        .post(`${API}/mobile/customer/addresses`)
        .set(auth(customer.accessToken))
        .send({ ...address, label: 'OFFICE' })
        .expect(201);

      await agent
        .delete(`${API}/mobile/customer/addresses/${first.body.data.id}`)
        .set(auth(customer.accessToken))
        .expect(204);

      const list = await agent.get(`${API}/mobile/customer/addresses`).set(auth(customer.accessToken)).expect(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0].isDefault).toBe(true);
    });

    it('rejects impossible coordinates', async () => {
      const customer = await activate(harness);

      const response = await http(harness)
        .post(`${API}/mobile/customer/addresses`)
        .set(auth(customer.accessToken))
        .send({ ...address, latitude: 91 })
        .expect(400);

      expect(response.body.errors[0].field).toBe('latitude');
    });

    it('keeps one customer’s addresses invisible to another', async () => {
      const owner = await activate(harness);
      const stranger = await activate(harness);

      const created = await http(harness)
        .post(`${API}/mobile/customer/addresses`)
        .set(auth(owner.accessToken))
        .send(address)
        .expect(201);

      await http(harness)
        .get(`${API}/mobile/customer/addresses/${created.body.data.id}`)
        .set(auth(stranger.accessToken))
        .expect(404);

      await http(harness)
        .patch(`${API}/mobile/customer/addresses/${created.body.data.id}`)
        .set(auth(stranger.accessToken))
        .send({ addressLine: 'Hijacked' })
        .expect(404);

      await http(harness)
        .delete(`${API}/mobile/customer/addresses/${created.body.data.id}`)
        .set(auth(stranger.accessToken))
        .expect(404);
    });

    it('refuses a driver account entirely', async () => {
      const driver = await activate(harness, 'DRIVER');

      const response = await http(harness)
        .get(`${API}/mobile/customer/addresses`)
        .set(auth(driver.accessToken))
        .expect(403);

      expect(response.body.code).toBe('ROLE_NOT_ALLOWED');
    });
  });

  describe('driver onboarding', () => {
    it('starts blocked, and says exactly why', async () => {
      const driver = await activate(harness, 'DRIVER');

      const response = await http(harness)
        .get(`${API}/mobile/driver/profile`)
        .set(auth(driver.accessToken))
        .expect(200);

      expect(response.body.data.approvalStatus).toBe('PENDING_APPROVAL');
      expect(response.body.data.availability).toBe('OFFLINE');
      expect(response.body.data.readiness.canGoOnline).toBe(false);
      expect(response.body.data.readiness.blockers).toEqual(
        expect.arrayContaining(['DRIVER_NOT_APPROVED', 'DRIVER_VEHICLE_REQUIRED', 'DRIVER_DOCUMENTS_INCOMPLETE']),
      );
      expect(response.body.data.readiness.requiredDocuments).toHaveLength(4);
    });

    it('registers a vehicle, which starts in review', async () => {
      const driver = await activate(harness, 'DRIVER');
      const vehicleType = await harness.prisma.vehicleType.findFirstOrThrow({ select: { id: true } });

      const response = await http(harness)
        .patch(`${API}/mobile/driver/vehicle`)
        .set(auth(driver.accessToken))
        .send({ vehicleTypeId: vehicleType.id, plateNumber: '1ab-2345', brand: 'Honda', year: 2022 })
        .expect(200);

      expect(response.body.data).toMatchObject({
        plateNumber: '1AB-2345', // normalised
        vehicleTypeCode: 'MOTOR',
        status: 'PENDING',
        isPrimary: true,
      });
    });

    it('updates the vehicle in place rather than creating a second one', async () => {
      const driver = await activate(harness, 'DRIVER');
      const vehicleType = await harness.prisma.vehicleType.findFirstOrThrow({ select: { id: true } });
      const agent = http(harness);

      await agent
        .patch(`${API}/mobile/driver/vehicle`)
        .set(auth(driver.accessToken))
        .send({ vehicleTypeId: vehicleType.id, plateNumber: '1AB-2345' })
        .expect(200);

      await agent
        .patch(`${API}/mobile/driver/vehicle`)
        .set(auth(driver.accessToken))
        .send({ vehicleTypeId: vehicleType.id, plateNumber: '2CD-9876', color: 'Red' })
        .expect(200);

      const vehicles = await harness.prisma.driverVehicle.findMany({ where: { driverId: driver.driverId as string } });
      expect(vehicles).toHaveLength(1);
      expect(vehicles[0].plateNumber).toBe('2CD-9876');
    });

    it('rejects an unknown vehicle type', async () => {
      const driver = await activate(harness, 'DRIVER');

      const response = await http(harness)
        .patch(`${API}/mobile/driver/vehicle`)
        .set(auth(driver.accessToken))
        .send({ vehicleTypeId: 'aaaaaaaaaaaaaaaaaaaaaaaa', plateNumber: '1AB-2345' })
        .expect(404);

      expect(response.body.code).toBe('VEHICLE_TYPE_NOT_FOUND');
    });

    it('accepts a document and supersedes the previous submission of that type', async () => {
      const driver = await activate(harness, 'DRIVER');
      const agent = http(harness);

      const firstFile = await uploadPng(driver.accessToken, 'DRIVER_DOCUMENT').expect(201);
      const secondFile = await uploadPng(driver.accessToken, 'DRIVER_DOCUMENT').expect(201);

      await agent
        .post(`${API}/mobile/driver/documents`)
        .set(auth(driver.accessToken))
        .send({ type: 'NATIONAL_ID_FRONT', fileId: firstFile.body.data.id })
        .expect(201);

      const resubmitted = await agent
        .post(`${API}/mobile/driver/documents`)
        .set(auth(driver.accessToken))
        .send({ type: 'NATIONAL_ID_FRONT', fileId: secondFile.body.data.id })
        .expect(201);

      expect(resubmitted.body.data.status).toBe('PENDING');

      const documents = await harness.prisma.driverDocument.findMany({
        where: { driverId: driver.driverId as string, type: 'NATIONAL_ID_FRONT' },
        select: { status: true },
      });

      expect(documents).toHaveLength(2);
      expect(documents.filter((d) => d.status === 'PENDING')).toHaveLength(1);
      expect(documents.filter((d) => d.status === 'EXPIRED')).toHaveLength(1);
    });

    it('serves documents only through expiring URLs', async () => {
      const driver = await activate(harness, 'DRIVER');
      const file = await uploadPng(driver.accessToken, 'DRIVER_DOCUMENT').expect(201);

      await http(harness)
        .post(`${API}/mobile/driver/documents`)
        .set(auth(driver.accessToken))
        .send({ type: 'NATIONAL_ID_FRONT', fileId: file.body.data.id })
        .expect(201);

      const documents = await http(harness)
        .get(`${API}/mobile/driver/documents`)
        .set(auth(driver.accessToken))
        .expect(200);

      expect(documents.body.data[0].fileUrl).toContain('X-Amz-Signature');
      expect(documents.body.data[0].fileUrlExpiresAt).toBeTruthy();
      expect(documents.body.data[0].required).toBe(true);
    });

    it('stays blocked while documents are only pending review', async () => {
      const driver = await activate(harness, 'DRIVER');
      const vehicleType = await harness.prisma.vehicleType.findFirstOrThrow({ select: { id: true } });
      const agent = http(harness);

      await agent
        .patch(`${API}/mobile/driver/vehicle`)
        .set(auth(driver.accessToken))
        .send({ vehicleTypeId: vehicleType.id, plateNumber: '1AB-2345' })
        .expect(200);

      for (const type of ['NATIONAL_ID_FRONT', 'NATIONAL_ID_BACK', 'DRIVER_LICENSE_FRONT', 'VEHICLE_REGISTRATION']) {
        const file = await uploadPng(driver.accessToken, 'DRIVER_DOCUMENT').expect(201);
        await agent
          .post(`${API}/mobile/driver/documents`)
          .set(auth(driver.accessToken))
          .send({ type, fileId: file.body.data.id })
          .expect(201);
      }

      const pending = await agent.get(`${API}/mobile/driver/profile`).set(auth(driver.accessToken)).expect(200);
      expect(pending.body.data.readiness.canGoOnline).toBe(false);
      expect(pending.body.data.readiness.blockers).toContain('DRIVER_DOCUMENTS_INCOMPLETE');

      // Approve everything the way an admin would.
      await harness.prisma.driverDocument.updateMany({
        where: { driverId: driver.driverId as string },
        data: { status: 'APPROVED' },
      });
      await harness.prisma.driverProfile.update({
        where: { id: driver.driverId as string },
        data: { approvalStatus: 'ACTIVE' },
      });

      const approved = await agent.get(`${API}/mobile/driver/profile`).set(auth(driver.accessToken)).expect(200);
      expect(approved.body.data.readiness.canGoOnline).toBe(true);
      expect(approved.body.data.readiness.blockers).toEqual([]);
    });

    it('refuses a customer account entirely', async () => {
      const customer = await activate(harness);

      await http(harness).get(`${API}/mobile/driver/profile`).set(auth(customer.accessToken)).expect(403);
    });
  });

  describe('vehicle types', () => {
    it('lists active types with their starting fare', async () => {
      const customer = await activate(harness);

      const response = await http(harness)
        .get(`${API}/mobile/vehicle-types`)
        .set(auth(customer.accessToken))
        .expect(200);

      expect(response.body.data[0]).toMatchObject({
        code: 'MOTOR',
        startingFare: { amount: 4_000, currency: 'KHR' },
        pricePerKm: { amount: 1_000, currency: 'KHR' },
      });
    });
  });
});
