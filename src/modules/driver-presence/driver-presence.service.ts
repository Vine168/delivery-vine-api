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

  /**
   * Positions for many drivers in one round trip.
   *
   * The operations map asks for every delivery in flight and is designed to be
   * polled, so fetching these one at a time made a single screen refresh cost
   * hundreds of sequential calls to Redis.
   */
  async getLocations(driverIds: string[]): Promise<Map<string, DriverFix>> {
    const unique = [...new Set(driverIds)];
    if (unique.length === 0) return new Map();

    const raw = await this.redis.client.mget(...unique.map((id) => RedisKey.driverLocation(id)));
    const fixes = new Map<string, DriverFix>();

    unique.forEach((driverId, index) => {
      const value = raw[index];
      if (!value) return;

      try {
        fixes.set(driverId, JSON.parse(value) as DriverFix);
      } catch {
        // A malformed fix is not worth failing the whole map for.
      }
    });

    return fixes;
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
   * How many drivers the matcher can actually see right now, and how many of
   * those are on a job.
   *
   * Counted from the same GEO indexes and heartbeat keys matching reads, not
   * from the availability table — a driver whose app was killed still has an
   * ONLINE row for a while, and a dashboard that counts those would promise
   * operators a fleet that is not there.
   */
  async countOnline(vehicleTypeCodes: string[]): Promise<{ online: number; busy: number }> {
    const online = await this.onlineDriverIds(vehicleTypeCodes);
    if (online.length === 0) return { online: 0, busy: 0 };

    const busy = new Set(await this.redis.client.smembers(RedisKey.driversBusy));
    return { online: online.length, busy: online.filter((driverId) => busy.has(driverId)).length };
  }

  /**
   * Exactly the drivers the matcher can see: in a GEO index and with a live
   * heartbeat. Used for counting them and for reaching them.
   */
  async onlineDriverIds(vehicleTypeCodes: string[]): Promise<string[]> {
    const indexed = new Set<string>();

    for (const code of vehicleTypeCodes) {
      const members = await this.redis.client.zrange(RedisKey.driverGeoIndex(code), 0, '-1');
      for (const driverId of members) indexed.add(driverId);
    }

    if (indexed.size === 0) return [];

    const candidates = [...indexed];
    const presence = await this.redis.client.mget(
      ...candidates.map((driverId) => RedisKey.driverPresence(driverId)),
    );

    return candidates.filter((_, index) => presence[index] !== null);
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
