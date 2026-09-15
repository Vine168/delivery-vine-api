import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './app-harness.js';
import { API, activate, adminAccount, http, pngFixture, scriptFixture } from './helpers.js';
import { REQUIRED_DRIVER_DOCUMENTS } from '../src/modules/drivers/driver.constants.js';

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
      .attach('file', pngFixture(), {
        filename: 'photo.png',
        contentType: 'image/png',
      })
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

      await http(harness)
        .delete(`${API}/mobile/customer/account`)
        .set(auth(customer.accessToken))
        .expect(204);

      // The session is dead.
      await http(harness)
        .get(`${API}/mobile/customer/profile`)
        .set(auth(customer.accessToken))
        .expect(401);

      // And the number can be registered again — after the OTP cooldown that
      // any repeat request for the same number is subject to.
      await harness.expireOtpCooldowns();
      await http(harness)
        .post(`${API}/auth/customer/register`)
        .send({ phone: customer.phone, fullName: 'Someone Else' })
        .expect(201);
    });

    it('will not delete an account whose wallet still holds money', async () => {
      const driver = await activate(harness, 'DRIVER');
      const wallet = await harness.prisma.wallet.create({
        data: { userId: driver.userId, currency: 'KHR', balance: 20_000 },
      });

      // A closed account could never sign in to withdraw it.
      const refused = await http(harness)
        .delete(`${API}/mobile/customer/account`)
        .set(auth(driver.accessToken))
        .expect(409);
      expect(refused.body.code).toBe('ACCOUNT_HAS_WALLET_BALANCE');

      await harness.prisma.wallet.update({ where: { id: wallet.id }, data: { balance: 0 } });

      await http(harness)
        .delete(`${API}/mobile/customer/account`)
        .set(auth(driver.accessToken))
        .expect(204);
    });

    it('will not delete an account while a withdrawal is being paid out', async () => {
      const driver = await activate(harness, 'DRIVER');
      const wallet = await harness.prisma.wallet.create({
        data: { userId: driver.userId, currency: 'KHR', balance: 20_000, reservedBalance: 20_000 },
      });
      await harness.prisma.withdrawal.create({
        data: {
          driverId: driver.driverId as string,
          walletId: wallet.id,
          amount: 20_000,
          netAmount: 20_000,
          currency: 'KHR',
        },
      });

      const refused = await http(harness)
        .delete(`${API}/mobile/customer/account`)
        .set(auth(driver.accessToken))
        .expect(409);
      expect(refused.body.code).toBe('ACCOUNT_HAS_PENDING_SETTLEMENT');
    });
  });

  describe('uploads', () => {
    it('stores a real image and returns a working URL', async () => {
      const customer = await activate(harness);

      const response = await uploadPng(
        customer.accessToken,
        'CUSTOMER_AVATAR',
      ).expect(201);

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
        .attach('file', scriptFixture(), {
          filename: 'avatar.png',
          contentType: 'image/png',
        })
        .field('purpose', 'CUSTOMER_AVATAR')
        .expect(415);

      expect(response.body.code).toBe('FILE_TYPE_NOT_ALLOWED');
    });

    it('refuses a purpose the caller role cannot use', async () => {
      const customer = await activate(harness);

      const response = await uploadPng(
        customer.accessToken,
        'DRIVER_DOCUMENT',
      ).expect(403);
      expect(response.body.code).toBe('ROLE_NOT_ALLOWED');
    });

    it('gives private files an expiring URL and public files a stable one', async () => {
      const driver = await activate(harness, 'DRIVER');

      const privateFile = await uploadPng(
        driver.accessToken,
        'DRIVER_DOCUMENT',
      ).expect(201);
      expect(privateFile.body.data.visibility).toBe('PRIVATE');
      expect(privateFile.body.data.urlExpiresAt).toBeTruthy();
      expect(privateFile.body.data.url).toContain('X-Amz-Signature');

      const publicFile = await uploadPng(
        driver.accessToken,
        'DRIVER_AVATAR',
      ).expect(201);
      expect(publicFile.body.data.url).not.toContain('X-Amz-Signature');
    });

    it('will not hand one user another user’s file', async () => {
      const owner = await activate(harness);
      const stranger = await activate(harness);

      const uploaded = await uploadPng(
        owner.accessToken,
        'CUSTOMER_AVATAR',
      ).expect(201);

      await http(harness)
        .get(`${API}/mobile/uploads/${uploaded.body.data.id}`)
        .set(auth(stranger.accessToken))
        .expect(404);
    });

    it('will not let a customer attach a file they do not own as their avatar', async () => {
      const owner = await activate(harness);
      const attacker = await activate(harness);

      const uploaded = await uploadPng(
        owner.accessToken,
        'CUSTOMER_AVATAR',
      ).expect(201);

      const response = await http(harness)
        .post(`${API}/mobile/customer/profile/avatar`)
        .set(auth(attacker.accessToken))
        .send({ fileId: uploaded.body.data.id })
        .expect(400);

      expect(response.body.code).toBe('FILE_NOT_FOUND');
    });

    it('attaches an avatar and exposes it on the profile', async () => {
      const customer = await activate(harness);
      const uploaded = await uploadPng(
        customer.accessToken,
        'CUSTOMER_AVATAR',
      ).expect(201);

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

      await agent
        .post(`${API}/mobile/customer/addresses`)
        .set(auth(customer.accessToken))
        .send(address)
        .expect(201);
      const second = await agent
        .post(`${API}/mobile/customer/addresses`)
        .set(auth(customer.accessToken))
        .send({ ...address, label: 'OFFICE', addressLine: 'Aeon Mall 1' })
        .expect(201);

      await agent
        .patch(
          `${API}/mobile/customer/addresses/${second.body.data.id}/default`,
        )
        .set(auth(customer.accessToken))
        .expect(200);

      const list = await agent
        .get(`${API}/mobile/customer/addresses`)
        .set(auth(customer.accessToken))
        .expect(200);

      expect(
        list.body.data.filter((a: { isDefault: boolean }) => a.isDefault),
      ).toHaveLength(1);
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

      const list = await agent
        .get(`${API}/mobile/customer/addresses`)
        .set(auth(customer.accessToken))
        .expect(200);
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

    it('serves a driver their own customer side', async () => {
      // One account, both apps: driving does not stop someone ordering.
      const driver = await activate(harness, 'DRIVER');

      const response = await http(harness)
        .get(`${API}/mobile/customer/addresses`)
        .set(auth(driver.accessToken))
        .expect(200);

      expect(response.body.data).toEqual([]);
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
        expect.arrayContaining([
          'DRIVER_NOT_APPROVED',
          'DRIVER_VEHICLE_REQUIRED',
          'DRIVER_DOCUMENTS_INCOMPLETE',
        ]),
      );
      expect(
        response.body.data.readiness.requiredDocuments.map(
          (document: { type: string }) => document.type,
        ),
      ).toEqual([...REQUIRED_DRIVER_DOCUMENTS]);
    });

    it('registers a vehicle, which starts in review', async () => {
      const driver = await activate(harness, 'DRIVER');
      const vehicleType = await harness.prisma.vehicleType.findFirstOrThrow({
        select: { id: true },
      });
      const photo = await uploadPng(driver.accessToken, 'VEHICLE_PHOTO').expect(
        201,
      );

      const response = await http(harness)
        .patch(`${API}/mobile/driver/vehicle`)
        .set(auth(driver.accessToken))
        .send({
          vehicleTypeId: vehicleType.id,
          plateNumber: '1ab-2345',
          brand: 'Honda',
          year: 2022,
          photoFileId: photo.body.data.id,
        })
        .expect(200);

      expect(response.body.data).toMatchObject({
        plateNumber: '1AB-2345', // normalised
        vehicleTypeCode: 'MOTOR',
        status: 'PENDING',
        isPrimary: true,
      });
    });

    it('records the national ID number and expiry with the application', async () => {
      const driver = await activate(harness, 'DRIVER');
      const vehicleType = await harness.prisma.vehicleType.findFirstOrThrow({ select: { id: true } });
      const nationalId = await uploadPng(driver.accessToken, 'NATIONAL_ID').expect(201);
      const avatar = await uploadPng(driver.accessToken, 'DRIVER_AVATAR').expect(201);
      const vehiclePhoto = await uploadPng(driver.accessToken, 'VEHICLE_PHOTO').expect(201);

      const application = (card: { number?: string; expiresAt: string }) => ({
        nationalId: { fileId: nationalId.body.data.id, number: card.number, expiresAt: card.expiresAt },
        avatarFileId: avatar.body.data.id,
        vehicle: {
          vehicleTypeId: vehicleType.id,
          plateNumber: '1AB-2345',
          brand: 'Honda',
          model: 'Dream 125',
          color: 'Black',
          year: 2022,
          photoFileId: vehiclePhoto.body.data.id,
        },
        banking: { bankName: 'ABA Bank', accountHolderName: 'CHAN SOPHEAK', accountNumber: '000123456789' },
      });
      const submit = (body: object) =>
        http(harness).post(`${API}/mobile/driver/application`).set(auth(driver.accessToken)).send(body);

      // Both are asked for, and an ID that has run out is refused before
      // anything is saved.
      await submit(application({ expiresAt: '2031-05-20' })).expect(400);
      const expired = await submit(application({ number: '010203040', expiresAt: '2020-01-31' })).expect(422);
      expect(expired.body.code).toBe('DRIVER_DOCUMENT_EXPIRED');

      await submit(application({ number: '0102 0304-0', expiresAt: '2031-05-20' })).expect(200);

      // The app is shown the last four; the full number never comes back to it.
      const documents = await http(harness)
        .get(`${API}/mobile/driver/documents`)
        .set(auth(driver.accessToken))
        .expect(200);
      expect(documents.body.data).toEqual([
        expect.objectContaining({ type: 'NATIONAL_ID_BACK', documentNumberLast4: '3040', expiresAt: '2031-05-20' }),
      ]);
      expect(JSON.stringify(documents.body)).not.toContain('010203040');

      // The operator reviewing it sees it in full, to check against the photo.
      const admin = await adminAccount(harness, ['admin.access', 'drivers.view']);
      const reviewed = await http(harness)
        .get(`${API}/admin/drivers/${driver.driverId}/documents`)
        .set(auth(admin.accessToken))
        .expect(200);
      expect(reviewed.body.data[0]).toMatchObject({
        type: 'NATIONAL_ID_BACK',
        documentNumber: '010203040',
        expiresAt: '2031-05-20',
      });

      // Sending the same form again leaves the document alone; a corrected
      // number is a new submission.
      await submit(application({ number: '010203040', expiresAt: '2031-05-20' })).expect(200);
      expect(await harness.prisma.driverDocument.count({ where: { driverId: driver.driverId as string } })).toBe(1);

      await submit(application({ number: '010203041', expiresAt: '2031-05-20' })).expect(200);
      expect(await harness.prisma.driverDocument.count({ where: { driverId: driver.driverId as string } })).toBe(2);
    });

    it('takes an optional driving licence and certificate with what is printed on them', async () => {
      const driver = await activate(harness, 'DRIVER');
      const vehicleType = await harness.prisma.vehicleType.findFirstOrThrow({ select: { id: true } });
      const upload = async (purpose: string): Promise<string> =>
        (await uploadPng(driver.accessToken, purpose).expect(201)).body.data.id;

      const nationalId = await upload('NATIONAL_ID');
      const licence = await upload('DRIVING_LICENSE');
      const certificate = await upload('CERTIFICATE_OF_REGISTRY');
      const avatar = await upload('DRIVER_AVATAR');
      const vehiclePhoto = await upload('VEHICLE_PHOTO');

      const base = {
        nationalId: { fileId: nationalId, number: '010203040', expiresAt: '2031-05-20' },
        avatarFileId: avatar,
        vehicle: {
          vehicleTypeId: vehicleType.id,
          plateNumber: '1AB-2345',
          brand: 'Honda',
          model: 'Dream 125',
          color: 'Black',
          year: 2022,
          photoFileId: vehiclePhoto,
        },
        banking: { bankName: 'ABA Bank', accountHolderName: 'CHAN SOPHEAK', accountNumber: '000123456789' },
      };
      const submit = (body: object) =>
        http(harness).post(`${API}/mobile/driver/application`).set(auth(driver.accessToken)).send(body);

      // Each file is uploaded as the document it is: a licence cannot stand in
      // for the national ID.
      const wrongFile = await submit({ ...base, nationalId: { ...base.nationalId, fileId: licence } }).expect(400);
      expect(wrongFile.body.code).toBe('FILE_NOT_FOUND');

      // The vehicle is described in full: a blank or missing brand is refused.
      await submit({ ...base, vehicle: { ...base.vehicle, brand: undefined } }).expect(400);
      await submit({ ...base, vehicle: { ...base.vehicle, brand: '   ' } }).expect(400);

      // Optional — but a licence that is sent needs its number and expiry.
      await submit({ ...base, drivingLicense: { fileId: licence } }).expect(400);
      const expired = await submit({
        ...base,
        drivingLicense: { fileId: licence, number: 'DL-12345', expiresAt: '2021-01-31' },
      }).expect(422);
      expect(expired.body.code).toBe('DRIVER_DOCUMENT_EXPIRED');

      await submit({
        ...base,
        drivingLicense: { fileId: licence, number: 'DL-12345', expiresAt: '2030-01-31' },
        // A certificate's expiry date is optional.
        certificateOfRegistry: { fileId: certificate, number: 'CR 998877' },
      }).expect(200);

      const documents = await http(harness)
        .get(`${API}/mobile/driver/documents`)
        .set(auth(driver.accessToken))
        .expect(200);
      expect(documents.body.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'DRIVER_LICENSE_FRONT', documentNumberLast4: '2345', expiresAt: '2030-01-31' }),
          expect.objectContaining({ type: 'CERTIFICATE_OF_REGISTRY', documentNumberLast4: '8877', expiresAt: null }),
        ]),
      );
    });

    it('shows a customer a blank form, and saves nothing from one that is refused', async () => {
      const customer = await activate(harness);

      // Before applying there is still a form to draw.
      const blank = await http(harness)
        .get(`${API}/mobile/driver/application`)
        .set(auth(customer.accessToken))
        .expect(200);
      expect(blank.body.data).toMatchObject({
        approvalStatus: null,
        submittedAt: null,
        canSubmit: false,
        blockers: ['DRIVER_NOT_ENROLLED'],
      });
      expect(blank.body.data.steps.length).toBeGreaterThan(0);
      expect(
        blank.body.data.steps.every((step: { status: string }) => step.status === 'NOT_SUBMITTED'),
      ).toBe(true);

      const vehicleType = await harness.prisma.vehicleType.findFirstOrThrow({ select: { id: true } });
      const upload = async (purpose: string): Promise<string> =>
        (await uploadPng(customer.accessToken, purpose).expect(201)).body.data.id;

      // Every part in order but the national ID, which is really a licence.
      // Refused — and nothing else is saved either, not even a driver profile.
      const refused = await http(harness)
        .post(`${API}/mobile/driver/application`)
        .set(auth(customer.accessToken))
        .send({
          nationalId: { fileId: await upload('DRIVING_LICENSE'), number: '010203040', expiresAt: '2031-05-20' },
          avatarFileId: await upload('DRIVER_AVATAR'),
          vehicle: {
            vehicleTypeId: vehicleType.id,
            plateNumber: '1AB-2345',
            brand: 'Honda',
            model: 'Dream 125',
            color: 'Black',
            year: 2022,
            photoFileId: await upload('VEHICLE_PHOTO'),
          },
          banking: { bankName: 'ABA Bank', accountHolderName: 'SOK DARA', accountNumber: '000123456789' },
        })
        .expect(400);
      expect(refused.body.code).toBe('FILE_NOT_FOUND');
      expect(await harness.prisma.driverProfile.count({ where: { userId: customer.userId } })).toBe(0);
    });

    it('updates the vehicle in place rather than creating a second one', async () => {
      const driver = await activate(harness, 'DRIVER');
      const vehicleType = await harness.prisma.vehicleType.findFirstOrThrow({
        select: { id: true },
      });
      const agent = http(harness);
      const firstPhoto = await uploadPng(
        driver.accessToken,
        'VEHICLE_PHOTO',
      ).expect(201);
      const secondPhoto = await uploadPng(
        driver.accessToken,
        'VEHICLE_PHOTO',
      ).expect(201);

      await agent
        .patch(`${API}/mobile/driver/vehicle`)
        .set(auth(driver.accessToken))
        .send({
          vehicleTypeId: vehicleType.id,
          plateNumber: '1AB-2345',
          photoFileId: firstPhoto.body.data.id,
        })
        .expect(200);

      await agent
        .patch(`${API}/mobile/driver/vehicle`)
        .set(auth(driver.accessToken))
        .send({
          vehicleTypeId: vehicleType.id,
          plateNumber: '2CD-9876',
          color: 'Red',
          photoFileId: secondPhoto.body.data.id,
        })
        .expect(200);

      const vehicles = await harness.prisma.driverVehicle.findMany({
        where: { driverId: driver.driverId as string },
      });
      expect(vehicles).toHaveLength(1);
      expect(vehicles[0].plateNumber).toBe('2CD-9876');
    });

    it('rejects an unknown vehicle type', async () => {
      const driver = await activate(harness, 'DRIVER');
      const vehiclePhoto = await uploadPng(
        driver.accessToken,
        'VEHICLE_PHOTO',
      ).expect(201);

      const response = await http(harness)
        .patch(`${API}/mobile/driver/vehicle`)
        .set(auth(driver.accessToken))
        .send({
          vehicleTypeId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
          plateNumber: '1AB-2345',
          photoFileId: vehiclePhoto.body.data.id,
        })
        .expect(404);

      expect(response.body.code).toBe('VEHICLE_TYPE_NOT_FOUND');
    });

    it('accepts a document and supersedes the previous submission of that type', async () => {
      const driver = await activate(harness, 'DRIVER');
      const agent = http(harness);

      const firstFile = await uploadPng(
        driver.accessToken,
        'DRIVER_DOCUMENT',
      ).expect(201);
      const secondFile = await uploadPng(
        driver.accessToken,
        'DRIVER_DOCUMENT',
      ).expect(201);

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
        where: {
          driverId: driver.driverId as string,
          type: 'NATIONAL_ID_FRONT',
        },
        select: { status: true },
      });

      expect(documents).toHaveLength(2);
      expect(documents.filter((d) => d.status === 'PENDING')).toHaveLength(1);
      expect(documents.filter((d) => d.status === 'EXPIRED')).toHaveLength(1);
    });

    it('serves documents only through expiring URLs', async () => {
      const driver = await activate(harness, 'DRIVER');
      const file = await uploadPng(
        driver.accessToken,
        'DRIVER_DOCUMENT',
      ).expect(201);

      await http(harness)
        .post(`${API}/mobile/driver/documents`)
        .set(auth(driver.accessToken))
        .send({ type: 'NATIONAL_ID_BACK', fileId: file.body.data.id })
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
      const vehicleType = await harness.prisma.vehicleType.findFirstOrThrow({
        select: { id: true },
      });
      const agent = http(harness);
      const vehiclePhoto = await uploadPng(
        driver.accessToken,
        'VEHICLE_PHOTO',
      ).expect(201);

      await agent
        .patch(`${API}/mobile/driver/vehicle`)
        .set(auth(driver.accessToken))
        .send({
          vehicleTypeId: vehicleType.id,
          plateNumber: '1AB-2345',
          photoFileId: vehiclePhoto.body.data.id,
        })
        .expect(200);

      for (const type of REQUIRED_DRIVER_DOCUMENTS) {
        const file = await uploadPng(
          driver.accessToken,
          'DRIVER_DOCUMENT',
        ).expect(201);
        await agent
          .post(`${API}/mobile/driver/documents`)
          .set(auth(driver.accessToken))
          .send({ type, fileId: file.body.data.id })
          .expect(201);
      }

      const pending = await agent
        .get(`${API}/mobile/driver/profile`)
        .set(auth(driver.accessToken))
        .expect(200);
      expect(pending.body.data.readiness.canGoOnline).toBe(false);
      expect(pending.body.data.readiness.blockers).toContain(
        'DRIVER_DOCUMENTS_INCOMPLETE',
      );

      // Approve everything the way an admin would — the vehicle included,
      // which readiness requires in its own right.
      const avatar = await uploadPng(
        driver.accessToken,
        'DRIVER_AVATAR',
      ).expect(201);
      await harness.prisma.driverProfile.update({
        where: { id: driver.driverId as string },
        data: { avatarFileId: avatar.body.data.id },
      });
      await harness.prisma.driverPaymentSetting.upsert({
        where: { driverId: driver.driverId as string },
        create: {
          driverId: driver.driverId as string,
          bankName: 'ABA Bank',
          accountHolderName: 'CHAN SOPHEAK',
          accountNumberEnc: 'encrypted',
          accountNumberLast4: '6789',
        },
        update: {
          bankName: 'ABA Bank',
          accountHolderName: 'CHAN SOPHEAK',
          accountNumberEnc: 'encrypted',
          accountNumberLast4: '6789',
        },
      });
      await harness.prisma.driverDocument.updateMany({
        where: { driverId: driver.driverId as string },
        data: { status: 'APPROVED' },
      });
      await harness.prisma.driverVehicle.updateMany({
        where: { driverId: driver.driverId as string },
        data: { status: 'APPROVED' },
      });
      await harness.prisma.driverProfile.update({
        where: { id: driver.driverId as string },
        data: { approvalStatus: 'ACTIVE' },
      });

      const approved = await agent
        .get(`${API}/mobile/driver/profile`)
        .set(auth(driver.accessToken))
        .expect(200);
      expect(approved.body.data.readiness.canGoOnline).toBe(true);
      expect(approved.body.data.readiness.blockers).toEqual([]);
    });

    it('requires an avatar and bank details before going online', async () => {
      const driver = await activate(harness, 'DRIVER');
      const vehicleType = await harness.prisma.vehicleType.findFirstOrThrow({
        select: { id: true },
      });
      const agent = http(harness);
      const vehiclePhoto = await uploadPng(
        driver.accessToken,
        'VEHICLE_PHOTO',
      ).expect(201);

      await agent
        .patch(`${API}/mobile/driver/vehicle`)
        .set(auth(driver.accessToken))
        .send({
          vehicleTypeId: vehicleType.id,
          plateNumber: '1AB-2345',
          photoFileId: vehiclePhoto.body.data.id,
        })
        .expect(200);

      for (const type of REQUIRED_DRIVER_DOCUMENTS) {
        const file = await uploadPng(
          driver.accessToken,
          'DRIVER_DOCUMENT',
        ).expect(201);
        await agent
          .post(`${API}/mobile/driver/documents`)
          .set(auth(driver.accessToken))
          .send({ type, fileId: file.body.data.id })
          .expect(201);
      }

      await harness.prisma.driverDocument.updateMany({
        where: { driverId: driver.driverId as string },
        data: { status: 'APPROVED' },
      });
      await harness.prisma.driverVehicle.updateMany({
        where: { driverId: driver.driverId as string },
        data: { status: 'APPROVED', reviewNote: null },
      });
      await harness.prisma.driverProfile.update({
        where: { id: driver.driverId as string },
        data: { approvalStatus: 'ACTIVE' },
      });

      const profile = await agent
        .get(`${API}/mobile/driver/profile`)
        .set(auth(driver.accessToken))
        .expect(200);
      expect(profile.body.data.readiness.canGoOnline).toBe(false);
      expect(profile.body.data.readiness.blockers).toEqual(
        expect.arrayContaining([
          'DRIVER_AVATAR_REQUIRED',
          'WITHDRAWAL_SETTINGS_REQUIRED',
        ]),
      );
    });

    it('requires a vehicle photo when registering a vehicle', async () => {
      const driver = await activate(harness, 'DRIVER');
      const vehicleType = await harness.prisma.vehicleType.findFirstOrThrow({
        select: { id: true },
      });

      const response = await http(harness)
        .patch(`${API}/mobile/driver/vehicle`)
        .set(auth(driver.accessToken))
        .send({ vehicleTypeId: vehicleType.id, plateNumber: '1AB-2345' })
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('refuses a customer account entirely', async () => {
      const customer = await activate(harness);

      await http(harness)
        .get(`${API}/mobile/driver/profile`)
        .set(auth(customer.accessToken))
        .expect(403);
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
