import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RedisKey } from '../../common/constants/redis-keys.js';
import { WsEvent } from '../../common/constants/events.js';
import { PrismaService } from '../../database/prisma.service.js';
import { RedisService } from '../../redis/redis.service.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  ActorType,
  AssignmentStatus,
  DeliveryStatus,
  DriverApprovalStatus,
  DriverAvailabilityStatus,
} from '../../generated/prisma/enums.js';
import { LocationsService } from '../locations/locations.service.js';
import type { RoutingProfile } from '../locations/providers/map-provider.interface.js';
import { DeliveryStateService } from '../deliveries/delivery-state.service.js';
import { DriverPresenceService } from '../driver-presence/driver-presence.service.js';

export interface OfferedJob {
  assignmentId: string;
  deliveryId: string;
  driverId: string;
  expiresAt: Date;
  distanceToPickupMeters: number;
  estimatedEarningAmount: number;
}

export interface RoundResult {
  round: number;
  radiusMeters: number;
  candidatesConsidered: number;
  offersMade: number;
  offers: OfferedJob[];
  /** Set when no offer could be made and no further round is worth running. */
  exhausted: boolean;
}

/**
 * Finds drivers for a delivery.
 *
 * Deliberately deterministic and inspectable rather than clever: nearest
 * eligible drivers within a radius that widens each round, favourites first,
 * a fixed batch size, a fixed offer window. Every decision it makes is
 * reconstructable from the assignment rows it writes.
 */
@Injectable()
export class DeliveryMatchingService {
  private readonly logger = new Logger(DeliveryMatchingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: DriverPresenceService,
    private readonly locations: LocationsService,
    private readonly state: DeliveryStateService,
    private readonly redis: RedisService,
    private readonly settings: SettingsService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * The dispatch parameters in force right now.
   *
   * Read per round rather than at construction so an operator's change takes
   * effect on the next booking instead of the next deploy. The settings
   * service caches in Redis, so this is one cheap read, and it falls back to
   * the values injected above when nothing is stored.
   */
  private async tuning(): Promise<{
    baseRadius: number;
    maxRadius: number;
    batchSize: number;
    offerTtlSeconds: number;
  }> {
    const settings = await this.settings.getNumbers([
      'matching.radiusMeters',
      'matching.maxRadiusMeters',
      'matching.batchSize',
      'matching.offerTtlSeconds',
    ] as const);

    return {
      baseRadius: settings['matching.radiusMeters'],
      maxRadius: settings['matching.maxRadiusMeters'],
      batchSize: settings['matching.batchSize'],
      offerTtlSeconds: settings['matching.offerTtlSeconds'],
    };
  }

  async roundLimit(): Promise<number> {
    return this.settings.getNumber('matching.maxRounds');
  }

  async offerWindowSeconds(): Promise<number> {
    return this.settings.getNumber('matching.offerTtlSeconds');
  }

  /**
   * One dispatch round. Returns what it did so the caller (a queue processor)
   * can decide whether to schedule another.
   */
  async runRound(deliveryId: string, round: number): Promise<RoundResult> {
    const tuning = await this.tuning();
    const radiusMeters = Math.min(tuning.baseRadius * round, tuning.maxRadius);
    const empty = (exhausted: boolean): RoundResult => ({
      round,
      radiusMeters,
      candidatesConsidered: 0,
      offersMade: 0,
      offers: [],
      exhausted,
    });

    const delivery = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      select: {
        id: true,
        status: true,
        bookingCode: true,
        customerId: true,
        pickupLatitude: true,
        pickupLongitude: true,
        driverEarningAmount: true,
        currency: true,
        vehicleTypeId: true,
        vehicleType: { select: { code: true, routingProfile: true } },
      },
    });

    // A delivery that was cancelled or already taken is simply not searched.
    if (!delivery || delivery.status !== DeliveryStatus.SEARCHING_DRIVER) {
      return empty(true);
    }

    // One round at a time per delivery, even across API instances.
    const release = await this.redis.acquireLock(RedisKey.matchingLock(deliveryId), 20);
    if (!release) {
      this.logger.debug(`Round ${round} for ${delivery.bookingCode} skipped: already dispatching`);
      return empty(false);
    }

    try {
      const pickup = { latitude: delivery.pickupLatitude, longitude: delivery.pickupLongitude };

      const nearby = await this.presence.findNearby(delivery.vehicleType.code, pickup, radiusMeters, 50);
      if (nearby.length === 0) {
        return empty(false);
      }

      const eligible = await this.filterEligible(
        deliveryId,
        delivery.customerId,
        nearby.map((driver) => driver.driverId),
      );

      if (eligible.candidates.length === 0) {
        return { ...empty(false), candidatesConsidered: nearby.length };
      }

      const byDriver = new Map(nearby.map((driver) => [driver.driverId, driver]));
      const ranked = await this.rank(
        eligible.candidates,
        byDriver,
        pickup,
        delivery.vehicleType.routingProfile as RoutingProfile,
        eligible.favouriteDriverIds,
      );

      const chosen = ranked.slice(0, tuning.batchSize);
      const expiresAt = new Date(Date.now() + tuning.offerTtlSeconds * 1000);

      const offers = await this.prisma.$transaction(async (tx) => {
        const created: OfferedJob[] = [];

        for (const candidate of chosen) {
          const assignment = await tx.deliveryAssignment.create({
            data: {
              deliveryId,
              driverId: candidate.driverId,
              round,
              status: AssignmentStatus.OFFERED,
              expiresAt,
              distanceToPickupMeters: candidate.distanceToPickupMeters,
              estimatedEarningAmount: delivery.driverEarningAmount,
              estimatedEarningCurrency: delivery.currency,
            },
            select: { id: true },
          });

          created.push({
            assignmentId: assignment.id,
            deliveryId,
            driverId: candidate.driverId,
            expiresAt,
            distanceToPickupMeters: candidate.distanceToPickupMeters,
            estimatedEarningAmount: delivery.driverEarningAmount,
          });
        }

        await tx.driverProfile.updateMany({
          where: { id: { in: chosen.map((candidate) => candidate.driverId) } },
          data: { offeredJobs: { increment: 1 } },
        });

        await tx.delivery.update({
          where: { id: deliveryId },
          data: { searchRound: round, searchExpiresAt: expiresAt },
        });

        return created;
      });

      for (const offer of offers) {
        this.events.emit(WsEvent.DRIVER_REQUEST_RECEIVED, offer);
      }

      this.logger.log(
        `${delivery.bookingCode} round ${round}: ${offers.length} offer(s) within ${radiusMeters} m`,
      );

      return {
        round,
        radiusMeters,
        candidatesConsidered: nearby.length,
        offersMade: offers.length,
        offers,
        exhausted: false,
      };
    } finally {
      await release();
    }
  }

  /**
   * Closes a round: any offer still unanswered lapses. Returns true when the
   * delivery is still looking and another round should be scheduled.
   */
  async expireRound(deliveryId: string, round: number): Promise<boolean> {
    const affected = await this.prisma.deliveryAssignment.findMany({
      where: { deliveryId, round, status: AssignmentStatus.OFFERED },
      select: { driverId: true },
    });

    const expired = await this.prisma.deliveryAssignment.updateMany({
      where: { deliveryId, round, status: AssignmentStatus.OFFERED },
      data: { status: AssignmentStatus.EXPIRED, respondedAt: new Date() },
    });

    if (expired.count > 0) {
      this.events.emit(WsEvent.DRIVER_REQUEST_EXPIRED, {
        deliveryId,
        round,
        driverIds: affected.map((row) => row.driverId),
      });
    }

    const delivery = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      select: { status: true },
    });

    return delivery?.status === DeliveryStatus.SEARCHING_DRIVER;
  }

  /** Nobody took it. The customer is told rather than left waiting. */
  async expireSearch(deliveryId: string): Promise<boolean> {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      select: { status: true },
    });

    if (delivery?.status !== DeliveryStatus.SEARCHING_DRIVER) return false;

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.deliveryAssignment.updateMany({
        where: { deliveryId, status: AssignmentStatus.OFFERED },
        data: { status: AssignmentStatus.EXPIRED, respondedAt: new Date() },
      });

      return this.state.transition(tx, {
        deliveryId,
        to: DeliveryStatus.EXPIRED,
        actorType: ActorType.SYSTEM,
        reason: 'No driver accepted the delivery',
      });
    });

    await this.state.publish(result);
    return true;
  }

  /** Called when one driver wins, or the customer cancels: everyone else is told to stop. */
  async cancelOutstandingOffers(deliveryId: string, exceptDriverId?: string): Promise<number> {
    const where = {
      deliveryId,
      status: AssignmentStatus.OFFERED,
      ...(exceptDriverId ? { NOT: { driverId: exceptDriverId } } : {}),
    };

    const affected = await this.prisma.deliveryAssignment.findMany({
      where,
      select: { driverId: true },
    });

    const { count } = await this.prisma.deliveryAssignment.updateMany({
      where,
      data: { status: AssignmentStatus.CANCELLED, respondedAt: new Date() },
    });

    if (count > 0) {
      this.events.emit(WsEvent.DRIVER_REQUEST_CANCELLED, {
        deliveryId,
        exceptDriverId,
        driverIds: affected.map((row) => row.driverId),
      });
    }

    return count;
  }

  // ── Eligibility and ranking ────────────────────────────────────────────

  /**
   * Redis says who is nearby; the database says who is allowed. Both are
   * consulted because presence can lag behind an approval change or a job that
   * started a second ago.
   */
  private async filterEligible(
    deliveryId: string,
    customerId: string,
    driverIds: string[],
  ): Promise<{ candidates: string[]; favouriteDriverIds: Set<string> }> {
    const [alreadyOffered, approved, busyFlags, favourites] = await Promise.all([
      this.prisma.deliveryAssignment.findMany({
        where: {
          deliveryId,
          driverId: { in: driverIds },
          // A driver who said no, already has it, or is still looking at it is
          // out. One whose offer merely lapsed is not: they may have been
          // riding and missed the notification, and on a thin fleet a second
          // chance beats nobody getting the job at all.
          status: {
            in: [AssignmentStatus.DECLINED, AssignmentStatus.ACCEPTED, AssignmentStatus.OFFERED],
          },
        },
        select: { driverId: true },
      }),
      this.prisma.driverProfile.findMany({
        where: {
          id: { in: driverIds },
          deletedAt: null,
          approvalStatus: DriverApprovalStatus.ACTIVE,
          availability: { status: DriverAvailabilityStatus.ONLINE },
          deliveries: { none: { status: { in: ACTIVE_DRIVER_STATUSES } } },
        },
        select: { id: true },
      }),
      Promise.all(driverIds.map((driverId) => this.presence.isBusy(driverId))),
      this.prisma.favoriteDriver.findMany({
        where: { customerId, driverId: { in: driverIds } },
        select: { driverId: true },
      }),
    ]);

    const seen = new Set(alreadyOffered.map((row) => row.driverId));
    const busy = new Set(driverIds.filter((_, index) => busyFlags[index]));
    const allowed = new Set(approved.map((row) => row.id));

    return {
      candidates: driverIds.filter((driverId) => allowed.has(driverId) && !seen.has(driverId) && !busy.has(driverId)),
      favouriteDriverIds: new Set(favourites.map((row) => row.driverId)),
    };
  }

  /**
   * Favourites first, then real road distance to the pickup, then the drivers
   * who actually accept work.
   *
   * The road distances come from one matrix call rather than one routing call
   * per driver — the difference between one request and fifty.
   */
  private async rank(
    driverIds: string[],
    nearby: Map<string, { distanceMeters: number; latitude: number; longitude: number }>,
    pickup: { latitude: number; longitude: number },
    profile: RoutingProfile,
    favouriteDriverIds: Set<string>,
  ): Promise<{ driverId: string; distanceToPickupMeters: number }[]> {
    const points = driverIds.map((driverId) => {
      const fix = nearby.get(driverId);
      return { latitude: fix?.latitude ?? pickup.latitude, longitude: fix?.longitude ?? pickup.longitude };
    });

    const matrix = await this.locations.distanceMatrix(pickup, points, profile);

    const stats = await this.prisma.driverProfile.findMany({
      where: { id: { in: driverIds } },
      select: { id: true, offeredJobs: true, acceptedJobs: true, ratingAverage: true },
    });
    const statsById = new Map(stats.map((row) => [row.id, row]));

    return driverIds
      .map((driverId, index) => {
        const stat = statsById.get(driverId);
        return {
          driverId,
          distanceToPickupMeters: matrix.distances[index] ?? nearby.get(driverId)?.distanceMeters ?? 0,
          isFavourite: favouriteDriverIds.has(driverId),
          acceptanceRate: stat && stat.offeredJobs > 0 ? stat.acceptedJobs / stat.offeredJobs : 1,
        };
      })
      .sort((a, b) => {
        if (a.isFavourite !== b.isFavourite) return a.isFavourite ? -1 : 1;
        if (a.distanceToPickupMeters !== b.distanceToPickupMeters) {
          return a.distanceToPickupMeters - b.distanceToPickupMeters;
        }
        return b.acceptanceRate - a.acceptanceRate;
      })
      .map(({ driverId, distanceToPickupMeters }) => ({ driverId, distanceToPickupMeters }));
  }
}

/** A driver holding any of these is not available for another job. */
const ACTIVE_DRIVER_STATUSES = [
  DeliveryStatus.DRIVER_ASSIGNED,
  DeliveryStatus.ARRIVED_PICKUP,
  DeliveryStatus.PICKED_UP,
  DeliveryStatus.IN_TRANSIT,
  DeliveryStatus.ARRIVED_DROPOFF,
];
