import { Injectable } from '@nestjs/common';
import { GeoUtil, type Coordinates } from '../../common/utils/geo.util.js';
import { PrismaService } from '../../database/prisma.service.js';
import { DriverPresenceService } from '../driver-presence/driver-presence.service.js';
import type { NearbyDriverDto, NearbyDriversQueryDto } from './dto/nearby-driver.dto.js';

/**
 * Three decimal places: a grid about 110 m across at Cambodian latitudes —
 * enough for a map pin, not for following anyone.
 */
const COORDINATE_PRECISION = 3;

/**
 * Further than rounding can move a point (half a cell's diagonal is ~80 m).
 * The search reaches this far past the radius, so the radius can then be
 * applied to the blurred pin without losing anyone near the edge.
 */
const BLUR_MARGIN_METERS = 100;

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
   *
   * Everything the caller sees is worked out from the blurred pin: the
   * distance, and whether the pin is inside the radius at all. The caller
   * picks both the centre and the radius, so an exact distance would let three
   * requests trilaterate the driver, and an exact cut-off would let one caller
   * shrink the radius until the pin vanished and read the distance off the
   * edge. Either would undo the blurring.
   */
  async find(query: NearbyDriversQueryDto): Promise<NearbyDriverDto[]> {
    const vehicleTypes = await this.prisma.vehicleType.findMany({
      where: { isActive: true, ...(query.vehicleTypeId ? { id: query.vehicleTypeId } : {}) },
      select: { code: true },
    });

    const centre: Coordinates = { latitude: query.latitude, longitude: query.longitude };

    const perType = await Promise.all(
      vehicleTypes.map(async (type) => {
        const drivers = await this.presence.findNearby(
          type.code,
          centre,
          query.radiusMeters + BLUR_MARGIN_METERS,
          query.limit,
        );
        const fixes = await this.presence.getLocations(drivers.map((driver) => driver.driverId));

        return drivers.map((driver): NearbyDriverDto => {
          const pin = { latitude: this.blur(driver.latitude), longitude: this.blur(driver.longitude) };

          return {
            ...pin,
            vehicleTypeCode: type.code,
            distanceMeters: GeoUtil.haversineMeters(centre, pin),
            heading: fixes.get(driver.driverId)?.heading ?? null,
          };
        });
      }),
    );

    return perType
      .flat()
      .filter((pin) => pin.distanceMeters <= query.radiusMeters)
      .sort((a, b) => a.distanceMeters - b.distanceMeters)
      .slice(0, query.limit);
  }

  private blur(coordinate: number): number {
    return Number(coordinate.toFixed(COORDINATE_PRECISION));
  }
}
