import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DomainEvent } from '../../common/constants/events.js';
import { RedisKey } from '../../common/constants/redis-keys.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { IN_FLIGHT_DELIVERY_STATUSES } from '../../common/constants/delivery-status.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import { PrismaService } from '../../database/prisma.service.js';
import { RedisService } from '../../redis/redis.service.js';
import { DriverAvailabilityStatus } from '../../generated/prisma/enums.js';
import { DriverReadinessService } from '../drivers/driver-readiness.service.js';
import { DriverPresenceService } from './driver-presence.service.js';
import {
  DriverAvailabilityInput,
  type DriverAvailabilityDto,
  type DriverLocationAckDto,
  type UpdateAvailabilityDto,
  type UpdateDriverLocationDto,
} from './dto/availability.dto.js';

@Injectable()
export class DriverAvailabilityService {
  private readonly logger = new Logger(DriverAvailabilityService.name);
  private readonly trackPointInterval: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: DriverPresenceService,
    private readonly readiness: DriverReadinessService,
    private readonly redis: RedisService,
    private readonly events: EventEmitter2,
    config: ConfigService,
  ) {
    this.trackPointInterval = config.get<number>('delivery.trackPointMinIntervalSeconds', 20);
  }

  async get(driverId: string): Promise<DriverAvailabilityDto> {
    const [availability, readiness, onlineSecondsToday] = await Promise.all([
      this.prisma.driverAvailability.findUnique({
        where: { driverId },
        select: { status: true, onlineSinceAt: true },
      }),
      this.readiness.evaluate(driverId),
      this.onlineSecondsToday(driverId),
    ]);

    return {
      status: availability?.status ?? DriverAvailabilityStatus.OFFLINE,
      onlineSinceAt: availability?.onlineSinceAt?.toISOString() ?? null,
      onlineSecondsToday,
      canGoOnline: readiness.canGoOnline,
      blockers: readiness.blockers,
    };
  }

  /**
   * Going online is a privilege, not a toggle: the server re-checks approval,
   * documents and vehicle every time, so an app that hides the checklist still
   * cannot put an unapproved driver into the matching pool.
   */
  async set(driverId: string, dto: UpdateAvailabilityDto): Promise<DriverAvailabilityDto> {
    return dto.status === DriverAvailabilityInput.ONLINE
      ? this.goOnline(driverId, dto)
      : this.goOffline(driverId);
  }

  private async goOnline(driverId: string, dto: UpdateAvailabilityDto): Promise<DriverAvailabilityDto> {
    const readiness = await this.readiness.evaluate(driverId);

    if (!readiness.canGoOnline) {
      throw AppException.unprocessable(
        (readiness.blockers[0] as ResponseCode) ?? ResponseCode.DRIVER_NOT_APPROVED,
        this.explain(readiness.blockers),
      );
    }

    const vehicle = await this.primaryVehicleOrThrow(driverId);
    const now = new Date();

    const availability = await this.prisma.$transaction(async (tx) => {
      const current = await tx.driverAvailability.findUnique({
        where: { driverId },
        select: { status: true, onlineSinceAt: true },
      });

      // Already working: going "online" again is a no-op, not a downgrade.
      if (current?.status === DriverAvailabilityStatus.BUSY) {
        return current;
      }

      if (current?.status !== DriverAvailabilityStatus.ONLINE) {
        await tx.driverOnlineSession.create({ data: { driverId, startedAt: now } });
      }

      return tx.driverAvailability.upsert({
        where: { driverId },
        create: {
          driverId,
          status: DriverAvailabilityStatus.ONLINE,
          onlineSinceAt: now,
          lastOnlineAt: now,
        },
        update: {
          status: DriverAvailabilityStatus.ONLINE,
          onlineSinceAt: current?.onlineSinceAt ?? now,
          lastOnlineAt: now,
        },
        select: { status: true, onlineSinceAt: true },
      });
    });

    await this.presence.goOnline(
      driverId,
      vehicle.vehicleType.code,
      dto.latitude !== undefined && dto.longitude !== undefined
        ? { latitude: dto.latitude, longitude: dto.longitude }
        : undefined,
    );

    this.events.emit(DomainEvent.DRIVER_WENT_ONLINE, { driverId, vehicleTypeCode: vehicle.vehicleType.code });

    return {
      status: availability.status,
      onlineSinceAt: availability.onlineSinceAt?.toISOString() ?? null,
      onlineSecondsToday: await this.onlineSecondsToday(driverId),
      canGoOnline: true,
      blockers: [],
    };
  }

  private async goOffline(driverId: string): Promise<DriverAvailabilityDto> {
    const active = await this.prisma.delivery.count({
      where: { driverId, status: { in: [...IN_FLIGHT_DELIVERY_STATUSES] } },
    });

    if (active > 0) {
      throw AppException.conflict(
        ResponseCode.DRIVER_HAS_ACTIVE_DELIVERY,
        'Finish or hand back your current delivery before going offline.',
      );
    }

    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      const openSession = await tx.driverOnlineSession.findFirst({
        where: { driverId, endedAt: null },
        orderBy: { startedAt: 'desc' },
        select: { id: true, startedAt: true },
      });

      if (openSession) {
        await tx.driverOnlineSession.update({
          where: { id: openSession.id },
          data: {
            endedAt: now,
            durationSeconds: Math.round((now.getTime() - openSession.startedAt.getTime()) / 1000),
          },
        });
      }

      await tx.driverAvailability.upsert({
        where: { driverId },
        create: { driverId, status: DriverAvailabilityStatus.OFFLINE, lastOfflineAt: now },
        update: { status: DriverAvailabilityStatus.OFFLINE, onlineSinceAt: null, lastOfflineAt: now },
      });
    });

    const vehicle = await this.prisma.driverVehicle.findFirst({
      where: { driverId, isPrimary: true, deletedAt: null },
      select: { vehicleType: { select: { code: true } } },
    });

    if (vehicle) {
      await this.presence.goOffline(driverId, vehicle.vehicleType.code);
    }

    this.events.emit(DomainEvent.DRIVER_WENT_OFFLINE, { driverId });

    return {
      status: DriverAvailabilityStatus.OFFLINE,
      onlineSinceAt: null,
      onlineSecondsToday: await this.onlineSecondsToday(driverId),
      canGoOnline: (await this.readiness.evaluate(driverId)).canGoOnline,
      blockers: [],
    };
  }

  /**
   * Accepts a GPS fix.
   *
   * Redis always gets it — that is what matching and the customer's map read.
   * Postgres gets a breadcrumb only while a delivery is in flight, and only
   * once per throttle window, so a busy fleet does not write millions of rows
   * nobody will ever read.
   */
  async updateLocation(driverId: string, dto: UpdateDriverLocationDto): Promise<DriverLocationAckDto> {
    const availability = await this.prisma.driverAvailability.findUnique({
      where: { driverId },
      select: { status: true },
    });

    if (!availability || availability.status === DriverAvailabilityStatus.OFFLINE) {
      throw AppException.unprocessable(
        ResponseCode.DRIVER_NOT_ONLINE,
        'Go online before sending your location.',
      );
    }

    const vehicle = await this.primaryVehicleOrThrow(driverId);
    const recordedAt = new Date();

    await this.presence.updateLocation(driverId, vehicle.vehicleType.code, {
      latitude: dto.latitude,
      longitude: dto.longitude,
      heading: dto.heading ?? null,
      speed: dto.speed ?? null,
      accuracy: dto.accuracy ?? null,
      recordedAt: recordedAt.toISOString(),
    });

    const activeDelivery = await this.prisma.delivery.findFirst({
      where: { driverId, status: { in: [...IN_FLIGHT_DELIVERY_STATUSES] } },
      select: { id: true },
    });

    if (!activeDelivery) {
      return { accepted: true, recorded: false, deliveryId: null };
    }

    const recorded = await this.recordTrackPoint(activeDelivery.id, driverId, dto, recordedAt);
    return { accepted: true, recorded, deliveryId: activeDelivery.id };
  }

  /** True when the fix was persisted; false when the throttle window swallowed it. */
  private async recordTrackPoint(
    deliveryId: string,
    driverId: string,
    dto: UpdateDriverLocationDto,
    recordedAt: Date,
  ): Promise<boolean> {
    const throttleKey = RedisKey.trackPointThrottle(deliveryId);
    const firstInWindow = await this.redis.client.set(throttleKey, '1', 'EX', this.trackPointInterval, 'NX');

    if (!firstInWindow) return false;

    await this.prisma.$transaction([
      this.prisma.deliveryTrackPoint.create({
        data: {
          deliveryId,
          latitude: dto.latitude,
          longitude: dto.longitude,
          heading: dto.heading,
          speed: dto.speed,
          recordedAt,
        },
      }),
      this.prisma.driverLocation.upsert({
        where: { driverId },
        create: {
          driverId,
          latitude: dto.latitude,
          longitude: dto.longitude,
          heading: dto.heading,
          speed: dto.speed,
          accuracy: dto.accuracy,
          recordedAt,
        },
        update: {
          latitude: dto.latitude,
          longitude: dto.longitude,
          heading: dto.heading,
          speed: dto.speed,
          accuracy: dto.accuracy,
          recordedAt,
        },
      }),
    ]);

    return true;
  }

  /** Server-managed: a driver never sets BUSY themselves. */
  async setBusy(driverId: string, busy: boolean): Promise<void> {
    const availability = await this.prisma.driverAvailability.findUnique({
      where: { driverId },
      select: { status: true },
    });

    // A driver who went offline mid-job stays offline when the job ends.
    if (!busy && availability?.status !== DriverAvailabilityStatus.BUSY) {
      await this.presence.markAvailable(driverId);
      return;
    }

    await this.prisma.driverAvailability.upsert({
      where: { driverId },
      create: { driverId, status: busy ? DriverAvailabilityStatus.BUSY : DriverAvailabilityStatus.ONLINE },
      update: { status: busy ? DriverAvailabilityStatus.BUSY : DriverAvailabilityStatus.ONLINE },
    });

    await (busy ? this.presence.markBusy(driverId) : this.presence.markAvailable(driverId));
  }

  async onlineSecondsToday(driverId: string): Promise<number> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const sessions = await this.prisma.driverOnlineSession.findMany({
      where: { driverId, startedAt: { gte: startOfDay } },
      select: { startedAt: true, endedAt: true, durationSeconds: true },
    });

    const now = Date.now();

    return sessions.reduce((total, session) => {
      if (session.durationSeconds !== null) return total + session.durationSeconds;
      // Still open — count up to now.
      return total + Math.round((now - session.startedAt.getTime()) / 1000);
    }, 0);
  }

  private async primaryVehicleOrThrow(driverId: string) {
    const vehicle = await this.prisma.driverVehicle.findFirst({
      where: { driverId, isPrimary: true, deletedAt: null },
      select: { id: true, vehicleTypeId: true, vehicleType: { select: { code: true } } },
    });

    if (!vehicle) {
      throw AppException.unprocessable(
        ResponseCode.DRIVER_VEHICLE_REQUIRED,
        'Register a vehicle before going online.',
      );
    }

    return vehicle;
  }

  private explain(blockers: string[]): string {
    if (blockers.includes(ResponseCode.DRIVER_SUSPENDED)) return 'Your account is suspended.';
    if (blockers.includes(ResponseCode.DRIVER_REJECTED)) return 'Your application was not approved.';
    if (blockers.includes(ResponseCode.DRIVER_NOT_APPROVED)) return 'Your account is still being reviewed.';
    if (blockers.includes(ResponseCode.DRIVER_VEHICLE_REQUIRED)) return 'Register a vehicle before going online.';
    return 'Upload all required documents and wait for approval before going online.';
  }
}
