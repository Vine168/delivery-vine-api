import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RedisKey } from '../../common/constants/redis-keys.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { IN_FLIGHT_DELIVERY_STATUSES } from '../../common/constants/delivery-status.js';
import { WsEvent } from '../../common/constants/events.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import { PhoneUtil } from '../../common/utils/phone.util.js';
import { PrismaService } from '../../database/prisma.service.js';
import { RedisService } from '../../redis/redis.service.js';
import {
  ActorType,
  AssignmentStatus,
  DeliveryStatus,
  DriverAvailabilityStatus,
} from '../../generated/prisma/enums.js';
import { DeliveryStateService } from '../deliveries/delivery-state.service.js';
import { DeliveryMatchingService } from '../delivery-matching/delivery-matching.service.js';
import { DriverAvailabilityService } from '../driver-presence/driver-availability.service.js';
import type { DeclineJobDto, JobOfferDto } from './dto/job.dto.js';

const jobSelect = {
  id: true,
  bookingCode: true,
  status: true,
  pickupAddress: true,
  pickupLatitude: true,
  pickupLongitude: true,
  pickupNote: true,
  pickupContactName: true,
  pickupContactPhone: true,
  dropoffAddress: true,
  dropoffLatitude: true,
  dropoffLongitude: true,
  dropoffNote: true,
  dropoffContactName: true,
  dropoffContactPhone: true,
  distanceMeters: true,
  durationSeconds: true,
  driverEarningAmount: true,
  currency: true,
  paymentMethod: true,
  codEnabled: true,
  codAmount: true,
  driverId: true,
  vehicleType: { select: { code: true } },
  customer: { select: { fullName: true } },
  packages: { select: { size: true, quantity: true, weightKg: true, category: true } },
} as const;

@Injectable()
export class DriverJobsService {
  private readonly logger = new Logger(DriverJobsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly state: DeliveryStateService,
    private readonly matching: DeliveryMatchingService,
    private readonly availability: DriverAvailabilityService,
    private readonly redis: RedisService,
    private readonly events: EventEmitter2,
  ) {}

  /** Offers this driver can still answer. */
  async findRequests(driverId: string): Promise<JobOfferDto[]> {
    const assignments = await this.prisma.deliveryAssignment.findMany({
      where: { driverId, status: AssignmentStatus.OFFERED, expiresAt: { gt: new Date() } },
      orderBy: { offeredAt: 'desc' },
      select: {
        expiresAt: true,
        distanceToPickupMeters: true,
        estimatedEarningAmount: true,
        delivery: { select: jobSelect },
      },
    });

    return assignments
      .filter((assignment) => assignment.delivery.status === DeliveryStatus.SEARCHING_DRIVER)
      .map((assignment) =>
        this.toOffer(assignment.delivery, {
          expiresAt: assignment.expiresAt,
          distanceToPickupMeters: assignment.distanceToPickupMeters,
          estimatedEarningAmount: assignment.estimatedEarningAmount,
          accepted: false,
        }),
      );
  }

  async findOne(driverId: string, deliveryId: string): Promise<JobOfferDto> {
    const assignment = await this.prisma.deliveryAssignment.findFirst({
      where: { deliveryId, driverId },
      orderBy: { offeredAt: 'desc' },
      select: {
        status: true,
        expiresAt: true,
        distanceToPickupMeters: true,
        estimatedEarningAmount: true,
        delivery: { select: jobSelect },
      },
    });

    if (!assignment) {
      // Never confirm that a delivery exists to a driver it was not offered to.
      throw AppException.notFound(ResponseCode.JOB_NOT_FOUND);
    }

    const accepted = assignment.status === AssignmentStatus.ACCEPTED;

    return this.toOffer(assignment.delivery, {
      expiresAt: accepted ? null : assignment.expiresAt,
      distanceToPickupMeters: assignment.distanceToPickupMeters,
      estimatedEarningAmount: assignment.estimatedEarningAmount,
      accepted,
    });
  }

  /**
   * Claims a delivery.
   *
   * Several drivers are offered the same job, and exactly one may win. Three
   * things make that true, in order of cost: a short Redis lock keeps the
   * common case off the database; a conditional UPDATE (`status` is still
   * SEARCHING_DRIVER **and** `driverId` is still null) decides the winner; and
   * a partial unique index on the assignment table is the final arbiter if
   * both of those were somehow wrong. The loser always gets 409
   * DELIVERY_ALREADY_ASSIGNED — never a 500, and never a silent overwrite.
   */
  async accept(driverId: string, userId: string, deliveryId: string): Promise<JobOfferDto> {
    const assignment = await this.assertOfferOpen(driverId, deliveryId);
    await this.assertDriverFree(driverId);

    const vehicle = await this.prisma.driverVehicle.findFirst({
      where: { driverId, isPrimary: true, deletedAt: null },
      select: { id: true },
    });

    const release = await this.redis.acquireLock(RedisKey.acceptLock(deliveryId), 10);
    if (!release) {
      throw AppException.conflict(ResponseCode.DELIVERY_ALREADY_ASSIGNED);
    }

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const transition = await this.state.transition(tx, {
          deliveryId,
          to: DeliveryStatus.DRIVER_ASSIGNED,
          actorType: ActorType.DRIVER,
          actorUserId: userId,
          expectedFrom: [DeliveryStatus.SEARCHING_DRIVER],
          // The condition that decides the race.
          where: { driverId: null },
          conflictCode: ResponseCode.DELIVERY_ALREADY_ASSIGNED,
          data: {
            driverId,
            driverVehicleId: vehicle?.id ?? null,
            searchExpiresAt: null,
          },
        });

        await tx.deliveryAssignment.update({
          where: { id: assignment.id },
          data: { status: AssignmentStatus.ACCEPTED, respondedAt: new Date() },
        });

        // Collected before the update: the losing drivers need to be named in
        // the event so their offer cards can be cleared.
        const losers = await tx.deliveryAssignment.findMany({
          where: { deliveryId, status: AssignmentStatus.OFFERED, NOT: { id: assignment.id } },
          select: { driverId: true },
        });

        await tx.deliveryAssignment.updateMany({
          where: { deliveryId, status: AssignmentStatus.OFFERED, NOT: { id: assignment.id } },
          data: { status: AssignmentStatus.CANCELLED, respondedAt: new Date() },
        });

        await tx.driverProfile.update({
          where: { id: driverId },
          data: { acceptedJobs: { increment: 1 } },
        });

        return { ...transition, driverId, loserIds: losers.map((row) => row.driverId) };
      });

      await this.availability.setBusy(driverId, true);

      this.state.publish(result);
      this.events.emit(WsEvent.DRIVER_REQUEST_CANCELLED, {
        deliveryId,
        exceptDriverId: driverId,
        driverIds: result.loserIds,
      });

      this.logger.log(`${result.bookingCode} accepted by driver ${driverId}`);

      return this.findOne(driverId, deliveryId);
    } finally {
      await release();
    }
  }

  /** Passing on a job. The driver is not offered it again in a later round. */
  async decline(driverId: string, deliveryId: string, dto: DeclineJobDto): Promise<void> {
    const assignment = await this.assertOfferOpen(driverId, deliveryId);

    await this.prisma.deliveryAssignment.update({
      where: { id: assignment.id },
      data: {
        status: AssignmentStatus.DECLINED,
        respondedAt: new Date(),
        declineReason: dto.reason,
      },
    });
  }

  // ── Guards ─────────────────────────────────────────────────────────────

  private async assertOfferOpen(driverId: string, deliveryId: string) {
    const assignment = await this.prisma.deliveryAssignment.findFirst({
      where: { deliveryId, driverId },
      orderBy: { offeredAt: 'desc' },
      select: { id: true, status: true, expiresAt: true },
    });

    if (!assignment) {
      throw AppException.notFound(ResponseCode.JOB_NOT_FOUND);
    }

    if (assignment.status !== AssignmentStatus.OFFERED) {
      throw AppException.conflict(
        assignment.status === AssignmentStatus.CANCELLED || assignment.status === AssignmentStatus.EXPIRED
          ? ResponseCode.JOB_OFFER_EXPIRED
          : ResponseCode.JOB_ALREADY_RESPONDED,
      );
    }

    if (assignment.expiresAt.getTime() <= Date.now()) {
      // Lazily expire it so the driver's own tap closes the offer.
      await this.prisma.deliveryAssignment.update({
        where: { id: assignment.id },
        data: { status: AssignmentStatus.EXPIRED, respondedAt: new Date() },
      });

      throw AppException.conflict(ResponseCode.JOB_OFFER_EXPIRED);
    }

    return assignment;
  }

  private async assertDriverFree(driverId: string): Promise<void> {
    const [availability, active] = await Promise.all([
      this.prisma.driverAvailability.findUnique({ where: { driverId }, select: { status: true } }),
      this.prisma.delivery.count({
        where: { driverId, status: { in: [...IN_FLIGHT_DELIVERY_STATUSES] } },
      }),
    ]);

    if (active > 0) {
      throw AppException.conflict(ResponseCode.DRIVER_HAS_ACTIVE_DELIVERY);
    }

    if (!availability || availability.status === DriverAvailabilityStatus.OFFLINE) {
      throw AppException.unprocessable(ResponseCode.DRIVER_NOT_ONLINE, 'Go online before accepting jobs.');
    }
  }

  // ── Mapping ────────────────────────────────────────────────────────────

  /**
   * Before acceptance a driver sees enough to decide and no more: areas,
   * distances, what they will earn. The customer's name and phone number are
   * withheld until they have actually taken the job.
   */
  private toOffer(
    delivery: {
      id: string;
      bookingCode: string;
      status: DeliveryStatus;
      pickupAddress: string;
      pickupLatitude: number;
      pickupLongitude: number;
      pickupNote: string | null;
      pickupContactName: string;
      pickupContactPhone: string;
      dropoffAddress: string;
      dropoffLatitude: number;
      dropoffLongitude: number;
      dropoffNote: string | null;
      dropoffContactName: string;
      dropoffContactPhone: string;
      distanceMeters: number;
      durationSeconds: number;
      driverEarningAmount: number;
      currency: JobOfferDto['currency'];
      paymentMethod: JobOfferDto['paymentMethod'];
      codEnabled: boolean;
      codAmount: number | null;
      vehicleType: { code: string };
      customer: { fullName: string } | null;
      packages: { size: JobOfferDto['packages'][number]['size']; quantity: number; weightKg: number | null; category: string | null }[];
    },
    context: {
      expiresAt: Date | null;
      distanceToPickupMeters: number | null;
      estimatedEarningAmount: number | null;
      accepted: boolean;
    },
  ): JobOfferDto {
    const reveal = context.accepted;

    return {
      deliveryId: delivery.id,
      bookingCode: delivery.bookingCode,
      status: delivery.status,
      pickup: {
        address: delivery.pickupAddress,
        latitude: delivery.pickupLatitude,
        longitude: delivery.pickupLongitude,
        note: delivery.pickupNote,
        contactName: reveal ? delivery.pickupContactName : null,
        contactPhone: reveal ? delivery.pickupContactPhone : PhoneUtil.mask(delivery.pickupContactPhone),
      },
      dropoff: {
        address: delivery.dropoffAddress,
        latitude: delivery.dropoffLatitude,
        longitude: delivery.dropoffLongitude,
        note: delivery.dropoffNote,
        contactName: reveal ? delivery.dropoffContactName : null,
        contactPhone: reveal ? delivery.dropoffContactPhone : PhoneUtil.mask(delivery.dropoffContactPhone),
      },
      distanceToPickupMeters: context.distanceToPickupMeters ?? 0,
      deliveryDistanceMeters: delivery.distanceMeters,
      estimatedDurationSeconds: delivery.durationSeconds,
      vehicleTypeCode: delivery.vehicleType.code,
      packages: delivery.packages,
      estimatedEarningAmount: context.estimatedEarningAmount ?? delivery.driverEarningAmount,
      currency: delivery.currency,
      paymentMethod: delivery.paymentMethod,
      codEnabled: delivery.codEnabled,
      codAmount: delivery.codAmount,
      customerName: reveal
        ? (delivery.customer?.fullName ?? null)
        : (delivery.customer?.fullName.split(' ')[0] ?? null),
      expiresAt: context.expiresAt?.toISOString() ?? null,
      accepted: context.accepted,
    };
  }
}
