import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisKey } from '../../common/constants/redis-keys.js';
import type { Coordinates } from '../../common/utils/geo.util.js';
import { RedisService } from '../../redis/redis.service.js';

export interface DriverFix {
  latitude: number;
  longitude: number;
  heading: number | null;
  speed: number | null;
  accuracy: number | null;
  recordedAt: string;
}

export interface NearbyDriver {
  driverId: string;
  distanceMeters: number;
  latitude: number;
  longitude: number;
}

/**
 * Live driver presence and position.
 *
 * All of it lives in Redis: a GEO index per vehicle type for "who is near
 * here", a per-driver heartbeat key whose TTL is what actually makes a driver
 * present, and the latest fix for the customer's tracking screen. None of this
 * is worth a database write — a fleet of a thousand drivers pinging every few
 * seconds would otherwise be millions of rows a day for data that is worthless
 * a minute later.
 */
@Injectable()
export class DriverPresenceService {
  private readonly logger = new Logger(DriverPresenceService.name);
  private readonly presenceTtl: number;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.presenceTtl = config.get<number>('delivery.driverPresenceTtlSeconds', 60);
  }

  /** Puts a driver into the pool for their vehicle type. */
  async goOnline(driverId: string, vehicleTypeCode: string, at?: Coordinates): Promise<void> {
    await this.redis.client.set(
      RedisKey.driverPresence(driverId),
      vehicleTypeCode,
      'EX',
      this.presenceTtl,
    );

    if (at) {
      await this.updateLocation(driverId, vehicleTypeCode, {
        latitude: at.latitude,
        longitude: at.longitude,
        heading: null,
        speed: null,
        accuracy: null,
        recordedAt: new Date().toISOString(),
      });
    }
  }

  async goOffline(driverId: string, vehicleTypeCode: string): Promise<void> {
    await Promise.all([
      this.redis.client.del(RedisKey.driverPresence(driverId)),
      this.redis.client.zrem(RedisKey.driverGeoIndex(vehicleTypeCode), driverId),
      this.redis.client.del(RedisKey.driverLocation(driverId)),
      this.redis.client.srem(RedisKey.driversBusy, driverId),
    ]);
  }

  /**
   * Records a GPS fix and refreshes the heartbeat.
   *
   * A driver whose app is killed simply stops pinging and drops out of the
   * index when the TTL lapses — no "am I still online?" bookkeeping.
   */
  async updateLocation(driverId: string, vehicleTypeCode: string, fix: DriverFix): Promise<void> {
    const geoKey = RedisKey.driverGeoIndex(vehicleTypeCode);

    await this.redis.client
      .multi()
      .geoadd(geoKey, fix.longitude, fix.latitude, driverId)
      .set(RedisKey.driverLocation(driverId), JSON.stringify(fix), 'EX', this.presenceTtl * 5)
      .set(RedisKey.driverPresence(driverId), vehicleTypeCode, 'EX', this.presenceTtl)
      .exec();
  }

  async getLocation(driverId: string): Promise<DriverFix | null> {
    return this.redis.getJson<DriverFix>(RedisKey.driverLocation(driverId));
  }

  async isOnline(driverId: string): Promise<boolean> {
    return (await this.redis.client.exists(RedisKey.driverPresence(driverId))) === 1;
  }

  /** Drivers currently on a job — eligible for nothing else. */
  async markBusy(driverId: string): Promise<void> {
    await this.redis.client.sadd(RedisKey.driversBusy, driverId);
  }

  async markAvailable(driverId: string): Promise<void> {
    await this.redis.client.srem(RedisKey.driversBusy, driverId);
  }

  async isBusy(driverId: string): Promise<boolean> {
    return (await this.redis.client.sismember(RedisKey.driversBusy, driverId)) === 1;
  }

  /**
   * Online drivers of one vehicle type within a radius, nearest first.
   *
   * The GEO index can hold a driver whose heartbeat has lapsed (GEOADD entries
   * have no TTL of their own), so each candidate's presence key is checked and
   * stale entries are swept out as they are found.
   */
  async findNearby(
    vehicleTypeCode: string,
    centre: Coordinates,
    radiusMeters: number,
    limit = 50,
  ): Promise<NearbyDriver[]> {
    const geoKey = RedisKey.driverGeoIndex(vehicleTypeCode);

    const rows = (await this.redis.client.geosearch(
      geoKey,
      'FROMLONLAT',
      centre.longitude,
      centre.latitude,
      'BYRADIUS',
      radiusMeters,
      'm',
      'ASC',
      'COUNT',
      limit,
      'WITHDIST',
      'WITHCOORD',
    )) as [string, string, [string, string]][];

    if (rows.length === 0) return [];

    // ioredis applies the client's keyPrefix to key arguments itself — adding
    // it here would look up `deliver:deliver:presence:…` and find nothing,
    // which reads as "every driver is stale" and empties the index.
    const presence = await this.redis.client.mget(
      ...rows.map(([driverId]) => RedisKey.driverPresence(driverId)),
    );

    const nearby: NearbyDriver[] = [];
    const stale: string[] = [];

    rows.forEach(([driverId, distance, [longitude, latitude]], index) => {
      if (presence[index] === null) {
        stale.push(driverId);
        return;
      }

      nearby.push({
        driverId,
        distanceMeters: Math.round(Number(distance)),
        latitude: Number(latitude),
        longitude: Number(longitude),
      });
    });

    if (stale.length > 0) {
      await this.redis.client.zrem(geoKey, ...stale);
      this.logger.debug(`Swept ${stale.length} stale drivers from ${vehicleTypeCode}`);
    }

    return nearby;
  }
}
