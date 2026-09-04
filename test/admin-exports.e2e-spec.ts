import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './app-harness.js';
import {
  API,
  activate,
  adminAccount,
  completedDelivery,
  http,
  readyDriver,
  type ActivatedAccount,
  type AdminAccount,
} from './helpers.js';

const NEARBY = { latitude: 11.557, longitude: 104.929 };

const EXPORT_OPS = [
  'admin.access',
  'deliveries.view',
  'deliveries.export',
  'drivers.view',
  'drivers.export',
  'customers.view',
  'customers.export',
  'finance.view',
  'finance.export',
];

/** Splits a CSV row, respecting quoted fields. */
function parseRow(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === ',') {
      fields.push(current);
      current = '';
    } else current += char;
  }

  fields.push(current);
  return fields;
}

function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const lines = text.replace(/^﻿/, '').trim().split('\n');
  return { header: parseRow(lines[0]), rows: lines.slice(1).map(parseRow) };
}

describe('Back office — CSV exports (e2e)', () => {
  let harness: TestHarness;
  let admin: AdminAccount;
  let customer: ActivatedAccount;
  let driver: ActivatedAccount;
  let vehicleTypeId: string;

  beforeAll(async () => {
    harness = await createTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
    harness.map.shouldFail = false;
    admin = await adminAccount(harness, EXPORT_OPS);
    customer = await activate(harness);
    driver = await readyDriver(harness, NEARBY);
    vehicleTypeId = (await harness.prisma.vehicleType.findFirstOrThrow({ select: { id: true } })).id;
  });

  const asAdmin = () => ({ Authorization: `Bearer ${admin.accessToken}` });

  describe('deliveries', () => {
    it('returns a downloadable file, not the response envelope', async () => {
      await completedDelivery(harness, customer, driver, vehicleTypeId);

      const response = await http(harness)
        .get(`${API}/admin/deliveries/export`)
        .set(asAdmin())
        .expect(200);

      expect(response.headers['content-type']).toContain('text/csv');
      expect(response.headers['content-disposition']).toMatch(/attachment; filename="deliveries-\d{4}-\d{2}-\d{2}\.csv"/);
      // Excel needs the byte-order mark to read Khmer names correctly.
      expect(response.text.startsWith('﻿')).toBe(true);
      expect(response.text).not.toContain('"success"');
    });

    it('writes money as minor units and as an exact decimal, with the currency', async () => {
      const delivery = await completedDelivery(harness, customer, driver, vehicleTypeId);
      const settled = await harness.prisma.delivery.findUniqueOrThrow({
        where: { id: delivery.deliveryId },
      });

      const response = await http(harness)
        .get(`${API}/admin/deliveries/export`)
        .set(asAdmin())
        .expect(200);

      const { header, rows } = parseCsv(response.text);
      expect(rows).toHaveLength(1);

      const value = (column: string) => rows[0][header.indexOf(column)];

      expect(value('booking_code')).toBe(delivery.bookingCode);
      expect(value('currency')).toBe('KHR');
      expect(value('total_amount_minor')).toBe(String(settled.totalAmount));
      // Riel have no minor unit, so the decimal form is the same integer.
      expect(value('total_amount')).toBe(String(settled.totalAmount));
      expect(value('commission_amount_minor')).toBe(String(settled.commissionAmount));
      expect(value('driver_earning_minor')).toBe(String(settled.driverEarningAmount));
      expect(value('customer_name')).toBe('Sok Dara');
      expect(value('driver_name')).toBe('Chan Sopheak');
    });

    it('writes dollars with two decimal places beside the minor units', async () => {
      const delivery = await completedDelivery(harness, customer, driver, vehicleTypeId);
      await harness.prisma.delivery.update({
        where: { id: delivery.deliveryId },
        data: { currency: 'USD', totalAmount: 1_580, commissionAmount: 296, driverEarningAmount: 1_284 },
      });

      const response = await http(harness)
        .get(`${API}/admin/deliveries/export`)
        .set(asAdmin())
        .expect(200);

      const { header, rows } = parseCsv(response.text);
      const value = (column: string) => rows[0][header.indexOf(column)];

      expect(value('currency')).toBe('USD');
      expect(value('total_amount')).toBe('15.80');
      expect(value('total_amount_minor')).toBe('1580');
      expect(value('commission_amount')).toBe('2.96');
    });

    it('exports exactly what the filters select', async () => {
      await completedDelivery(harness, customer, driver, vehicleTypeId);

      const cancelled = await http(harness)
        .post(`${API}/mobile/customer/deliveries`)
        .set({ Authorization: `Bearer ${customer.accessToken}` })
        .send({
          pickup: {
            address: 'Independence Monument',
            latitude: 11.5564,
            longitude: 104.9282,
            contactName: 'Sok Dara',
            contactPhone: '012345678',
          },
          dropoff: {
            address: 'Chak Angrae',
            latitude: 11.5,
            longitude: 104.87,
            contactName: 'Chan Vuthy',
            contactPhone: '012999888',
          },
          vehicleTypeId,
          currency: 'KHR',
          packages: [{ size: 'SMALL', weightKg: 2 }],
          paymentMethod: 'CASH_ON_DELIVERY',
        })
        .expect(201);

      const everything = await http(harness).get(`${API}/admin/deliveries/export`).set(asAdmin()).expect(200);
      expect(parseCsv(everything.text).rows).toHaveLength(2);

      const delivered = await http(harness)
        .get(`${API}/admin/deliveries/export?status=DELIVERED`)
        .set(asAdmin())
        .expect(200);
      const { header, rows } = parseCsv(delivered.text);
      expect(rows).toHaveLength(1);
      expect(rows[0][header.indexOf('status')]).toBe('DELIVERED');
      expect(cancelled.body.data.id).toBeTruthy();
    });

    it('keeps an address containing a comma in a single column', async () => {
      await completedDelivery(harness, customer, driver, vehicleTypeId);
      await harness.prisma.delivery.updateMany({
        data: { pickupAddress: 'Street 271, Toul Kork, Phnom Penh' },
      });

      const response = await http(harness).get(`${API}/admin/deliveries/export`).set(asAdmin()).expect(200);
      const { header, rows } = parseCsv(response.text);

      expect(rows[0]).toHaveLength(header.length);
      expect(rows[0][header.indexOf('pickup_address')]).toBe('Street 271, Toul Kork, Phnom Penh');
    });

    it('neutralises a value a spreadsheet would run as a formula', async () => {
      await completedDelivery(harness, customer, driver, vehicleTypeId);
      await harness.prisma.customerProfile.updateMany({
        where: { id: customer.customerId as string },
        data: { fullName: '=HYPERLINK("http://evil","Click")' },
      });

      const response = await http(harness).get(`${API}/admin/deliveries/export`).set(asAdmin()).expect(200);
      const { header, rows } = parseCsv(response.text);

      expect(rows[0][header.indexOf('customer_name')]).toBe('\'=HYPERLINK("http://evil","Click")');
    });
  });

  describe('drivers and customers', () => {
    it('exports the fleet with zones and rates', async () => {
      const response = await http(harness).get(`${API}/admin/drivers/export`).set(asAdmin()).expect(200);
      const { header, rows } = parseCsv(response.text);

      expect(rows).toHaveLength(1);
      expect(rows[0][header.indexOf('full_name')]).toBe('Chan Sopheak');
      expect(rows[0][header.indexOf('approval_status')]).toBe('ACTIVE');
      expect(rows[0][header.indexOf('rating_average')]).toBe('0.00');
      expect(rows[0][header.indexOf('acceptance_rate_percent')]).toBe('0.00');
    });

    it('honours the fleet filters', async () => {
      const pending = await activate(harness, 'DRIVER');
      await harness.prisma.driverProfile.update({
        where: { id: pending.driverId as string },
        data: { approvalStatus: 'PENDING_APPROVAL' },
      });

      const response = await http(harness)
        .get(`${API}/admin/drivers/export?approvalStatus=PENDING_APPROVAL`)
        .set(asAdmin())
        .expect(200);

      const { header, rows } = parseCsv(response.text);
      expect(rows).toHaveLength(1);
      expect(rows[0][header.indexOf('approval_status')]).toBe('PENDING_APPROVAL');
    });

    it('exports customers with their booking counts', async () => {
      await completedDelivery(harness, customer, driver, vehicleTypeId);

      const response = await http(harness).get(`${API}/admin/customers/export`).set(asAdmin()).expect(200);
      const { header, rows } = parseCsv(response.text);

      expect(rows).toHaveLength(1);
      expect(rows[0][header.indexOf('full_name')]).toBe('Sok Dara');
      expect(rows[0][header.indexOf('deliveries')]).toBe('1');
    });
  });

  describe('withdrawals', () => {
    it('never puts a full account number in the file', async () => {
      await completedDelivery(harness, customer, driver, vehicleTypeId);
      await completedDelivery(harness, customer, driver, vehicleTypeId);

      await http(harness)
        .put(`${API}/mobile/driver/withdrawal-settings`)
        .set({ Authorization: `Bearer ${driver.accessToken}` })
        .send({ bankName: 'ABA Bank', accountHolderName: 'CHAN SOPHEAK', accountNumber: '000123456789' })
        .expect(200);

      await http(harness)
        .post(`${API}/mobile/driver/withdrawals`)
        .set({ Authorization: `Bearer ${driver.accessToken}` })
        .send({ amount: 20_000, currency: 'KHR', method: 'BANK_TRANSFER' })
        .expect(201);

      const response = await http(harness)
        .get(`${API}/admin/finance/withdrawals/export`)
        .set(asAdmin())
        .expect(200);

      const { header, rows } = parseCsv(response.text);
      expect(rows).toHaveLength(1);
      expect(rows[0][header.indexOf('account_last4')]).toBe('6789');
      expect(rows[0][header.indexOf('amount_minor')]).toBe('20000');
      expect(response.text).not.toContain('000123456789');
      expect(header).not.toContain('account_number');
    });
  });

  describe('safeguards', () => {
    it('refuses rather than truncating an export that is too large', async () => {
      await completedDelivery(harness, customer, driver, vehicleTypeId);

      // Pretend the filter covers more rows than an export may carry.
      const { AdminExportService } = await import(
        '../src/modules/admin/services/admin-export.service.js'
      );
      const service = harness.app.get(AdminExportService);
      const original = harness.prisma.delivery.count.bind(harness.prisma.delivery);
      harness.prisma.delivery.count = (() => Promise.resolve(50_001)) as typeof original;

      try {
        await expect(
          service.deliveries(admin.userId, {}, {} as never),
        ).rejects.toMatchObject({ code: 'EXPORT_TOO_LARGE' });
      } finally {
        harness.prisma.delivery.count = original;
      }
    });

    it('records who exported what', async () => {
      await completedDelivery(harness, customer, driver, vehicleTypeId);
      await http(harness).get(`${API}/admin/deliveries/export`).set(asAdmin()).expect(200);

      const audit = await harness.prisma.auditLog.findFirstOrThrow({
        where: { action: 'export.deliveries' },
      });
      expect(audit.actorUserId).toBe(admin.userId);
      expect(audit.summary).toContain('1 deliveries row(s)');
    });

    it('separates viewing a list from taking it away', async () => {
      const viewer = await adminAccount(harness, ['admin.access', 'deliveries.view', 'finance.view']);

      await http(harness)
        .get(`${API}/admin/deliveries`)
        .set({ Authorization: `Bearer ${viewer.accessToken}` })
        .expect(200);

      const refused = await http(harness)
        .get(`${API}/admin/deliveries/export`)
        .set({ Authorization: `Bearer ${viewer.accessToken}` })
        .expect(403);
      expect(refused.body.message).toContain('export');

      await http(harness)
        .get(`${API}/admin/finance/withdrawals/export`)
        .set({ Authorization: `Bearer ${viewer.accessToken}` })
        .expect(403);
    });
  });
});
