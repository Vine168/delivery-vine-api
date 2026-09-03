import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { DriverPresenceService } from '../driver-presence/driver-presence.service.js';
import type { NearbyDriverDto, NearbyDriversQueryDto } from './dto/nearby-driver.dto.js';

/** ~30 m at Cambodian latitudes — enough for a map pin, not for following anyone. */
const COORDINATE_PRECISION = 3.5;

@Injectable()
export class NearbyDriversService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: DriverPresenceService,
  ) {}

  /**
   * Live driver pins for the booking map, straight from Redis.
   *
   * Returns no identity at all: the customer has not booked anything yet, so
   * there is nothing they legitimately need beyond "a motorbike is 600 m away".
   */
  async find(query: NearbyDriversQueryDto): Promise<NearbyDriverDto[]> {
    const vehicleTypes = await this.prisma.vehicleType.findMany({
      where: { isActive: true, ...(query.vehicleTypeId ? { id: query.vehicleTypeId } : {}) },
      select: { code: true },
    });

    const centre = { latitude: query.latitude, longitude: query.longitude };

    const perType = await Promise.all(
      vehicleTypes.map(async (type) => {
        const drivers = await this.presence.findNearby(type.code, centre, query.radiusMeters, query.limit);

        return Promise.all(
          drivers.map(async (driver) => {
            const fix = await this.presence.getLocation(driver.driverId);

            return {
              latitude: this.blur(driver.latitude),
              longitude: this.blur(driver.longitude),
              vehicleTypeCode: type.code,
              distanceMeters: driver.distanceMeters,
              heading: fix?.heading ?? null,
            };
          }),
        );
      }),
    );

    return perType
      .flat()
      .sort((a, b) => a.distanceMeters - b.distanceMeters)
      .slice(0, query.limit);
  }

  private blur(coordinate: number): number {
    return Number(coordinate.toFixed(COORDINATE_PRECISION));
  }
}
