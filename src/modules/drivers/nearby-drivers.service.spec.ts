import { describe, expect, it } from 'vitest';
import { GeoUtil, type Coordinates } from '../../common/utils/geo.util.js';
import type { PrismaService } from '../../database/prisma.service.js';
import type { DriverPresenceService } from '../driver-presence/driver-presence.service.js';
import type { NearbyDriversQueryDto } from './dto/nearby-driver.dto.js';
import { NearbyDriversService } from './nearby-drivers.service.js';

const CENTRE: Coordinates = { latitude: 11.5564, longitude: 104.9282 };

/** Rounds to PIN, which is about 60 m nearer the centre than the driver really is. */
const DRIVER: Coordinates = { latitude: 11.5604, longitude: 104.9334 };
const PIN: Coordinates = { latitude: 11.56, longitude: 104.933 };

/** Presence as Redis answers it: exact positions and distances, cut at the radius. */
function serviceWithDriverAt(position: Coordinates) {
  const prisma = { vehicleType: { findMany: async () => [{ code: 'MOTOR' }] } };
  const presence = {
    async findNearby(_code: string, centre: Coordinates, radiusMeters: number) {
      const distanceMeters = GeoUtil.haversineMeters(centre, position);
      return distanceMeters <= radiusMeters ? [{ driverId: 'drv_1', distanceMeters, ...position }] : [];
    },
    async getLocations() {
      return new Map([['drv_1', { heading: 90 }]]);
    },
  };

  return new NearbyDriversService(
    prisma as unknown as PrismaService,
    presence as unknown as DriverPresenceService,
  );
}

const query = (radiusMeters: number) => ({ ...CENTRE, radiusMeters, limit: 20 }) as NearbyDriversQueryDto;

describe('NearbyDriversService', () => {
  const pinDistance = GeoUtil.haversineMeters(CENTRE, PIN);

  it('draws the pin on a coarse grid', async () => {
    const [pin] = await serviceWithDriverAt(DRIVER).find(query(5_000));

    expect(pin).toMatchObject({ ...PIN, vehicleTypeCode: 'MOTOR', heading: 90 });
  });

  it('reports the distance to the pin, not to the driver', async () => {
    const [pin] = await serviceWithDriverAt(DRIVER).find(query(5_000));

    expect(pin.distanceMeters).toBe(pinDistance);
    expect(pin.distanceMeters).not.toBe(GeoUtil.haversineMeters(CENTRE, DRIVER));
  });

  it('applies the radius to the pin, so narrowing it cannot reveal the true distance', async () => {
    const service = serviceWithDriverAt(DRIVER);

    // The driver is really further out than the pin; the edge follows the pin.
    expect(await service.find(query(pinDistance))).toHaveLength(1);
    expect(await service.find(query(pinDistance - 1))).toHaveLength(0);
  });
});
