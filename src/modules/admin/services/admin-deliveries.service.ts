import { Injectable, Logger } from '@nestjs/common';
import { ACTIVE_DELIVERY_STATUSES } from '../../../common/constants/delivery-status.js';
import { ResponseCode } from '../../../common/constants/response-codes.js';
import { AppException } from '../../../common/exceptions/app.exception.js';
import { PaginationUtil } from '../../../common/utils/pagination.util.js';
import type { PaginatedResult } from '../../../common/interfaces/paginated.interface.js';
import { PrismaService } from '../../../database/prisma.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { ActorType, AssignmentStatus, DeliveryStatus } from '../../../generated/prisma/enums.js';
import { DeliveryStateService } from '../../deliveries/delivery-state.service.js';
import { DeliveryMatchingService } from '../../delivery-matching/delivery-matching.service.js';
import { DriverAvailabilityService } from '../../driver-presence/driver-availability.service.js';
import { DriverPresenceService } from '../../driver-presence/driver-presence.service.js';
import { FileUrlService } from '../../uploads/file-url.service.js';
import { AuditService } from '../audit.service.js';
import type {
  AdminCancelDeliveryDto,
  AdminDeliveryDetailDto,
  AdminDeliveryQueryDto,
  AdminDeliveryRowDto,
  AdminDeliveryTimelineEntryDto,
  AdminLiveDeliveryDto,
  AdminReassignDeliveryDto,
} from '../dto/admin-delivery.dto.js';

const listSelect = {
  id: true,
  bookingCode: true,
  status: true,
  pickupAddress: true,
  dropoffAddress: true,
  distanceMeters: true,
  totalAmount: true,
  commissionAmount: true,
  driverEarningAmount: true,
  currency: true,
  paymentMethod: true,
  paymentStatus: true,
  createdAt: true,
  confirmedAt: true,
  deliveredAt: true,
  vehicleType: { select: { code: true } },
  customer: {
    select: { id: true, fullName: true, avatarFileId: true, user: { select: { phone: true } } },
  },
  driver: {
    select: { id: true, fullName: true, avatarFileId: true, user: { select: { phone: true } } },
  },
} as const;

/**
 * Deliveries as an operator sees them.
 *
 * The customer's view of a delivery deliberately hides the platform split;
 * this one shows it, along with the dispatch trail — every driver the job was
 * offered to and what they did with it — because that is what a support call
 * about "why did nobody pick this up" actually needs.
 */
@Injectable()
export class AdminDeliveriesService {
  private readonly logger = new Logger(AdminDeliveriesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly state: DeliveryStateService,
    private readonly matching: DeliveryMatchingService,
    private readonly presence: DriverPresenceService,
    private readonly availability: DriverAvailabilityService,
    private readonly fileUrls: FileUrlService,
    private readonly audit: AuditService,
  ) {}

  async findAll(query: AdminDeliveryQueryDto): Promise<PaginatedResult<AdminDeliveryRowDto>> {
    const where = this.buildWhere(query);

    const [rows, total] = await Promise.all([
      this.prisma.delivery.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
        select: listSelect,
      }),
      this.prisma.delivery.count({ where }),
    ]);

    const avatars = await this.fileUrls.resolveMany(
      rows.flatMap((row) => [row.customer?.avatarFileId, row.driver?.avatarFileId]),
    );

    return PaginationUtil.paginate(
      rows.map((row) => this.toRow(row, avatars)),
      query.page,
      query.limit,
      total,
    );
  }

  async findOne(deliveryId: string): Promise<AdminDeliveryDetailDto> {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      select: {
        ...listSelect,
        pickupLatitude: true,
        pickupLongitude: true,
        dropoffLatitude: true,
        dropoffLongitude: true,
        pickupContactName: true,
        pickupContactPhone: true,
        dropoffContactName: true,
        dropoffContactPhone: true,
        pickupNote: true,
        dropoffNote: true,
        durationSeconds: true,
        routePolyline: true,
        pricingSnapshot: true,
        codEnabled: true,
        codAmount: true,
        codPayer: true,
        codCollectedAt: true,
        cancelledByType: true,
        cancelReason: true,
        packages: {
          select: {
            id: true,
            size: true,
            quantity: true,
            weightKg: true,
            category: true,
            description: true,
            remarks: true,
            photoFileId: true,
          },
        },
        proof: {
          select: { photoFileId: true, recipientName: true, note: true, capturedAt: true },
        },
        rating: { select: { rating: true, comment: true, tags: true, createdAt: true } },
        statusHistory: {
          orderBy: { createdAt: 'asc' },
          select: {
            fromStatus: true,
            toStatus: true,
            actorType: true,
            reason: true,
            metadata: true,
            createdAt: true,
            actor: {
              select: {
                adminProfile: { select: { fullName: true } },
                customerProfile: { select: { fullName: true } },
                driverProfile: { select: { fullName: true } },
              },
            },
          },
        },
        assignments: {
          orderBy: { offeredAt: 'asc' },
          select: {
            status: true,
            round: true,
            distanceToPickupMeters: true,
            declineReason: true,
            offeredAt: true,
            respondedAt: true,
            driver: { select: { id: true, fullName: true } },
          },
        },
      },
    });

    if (!delivery) {
      throw AppException.notFound(ResponseCode.DELIVERY_NOT_FOUND);
    }

    const [avatars, photoUrls, proofUrl] = await Promise.all([
      this.fileUrls.resolveMany([delivery.customer?.avatarFileId, delivery.driver?.avatarFileId]),
      this.fileUrls.resolveMany(delivery.packages.map((item) => item.photoFileId)),
      this.fileUrls.resolveById(delivery.proof?.photoFileId),
    ]);

    const snapshot = delivery.pricingSnapshot as { breakdown?: Record<string, unknown> } | null;

    return {
      ...this.toRow(delivery, avatars),
      pickupLatitude: delivery.pickupLatitude,
      pickupLongitude: delivery.pickupLongitude,
      dropoffLatitude: delivery.dropoffLatitude,
      dropoffLongitude: delivery.dropoffLongitude,
      pickupContactName: delivery.pickupContactName,
      pickupContactPhone: delivery.pickupContactPhone,
      dropoffContactName: delivery.dropoffContactName,
      dropoffContactPhone: delivery.dropoffContactPhone,
      pickupNote: delivery.pickupNote,
      dropoffNote: delivery.dropoffNote,
      durationSeconds: delivery.durationSeconds,
      routePolyline: delivery.routePolyline,
      // The operator view keeps the commission and driver earning that the
      // customer's copy of this breakdown has stripped out.
      price: snapshot?.breakdown ?? {},
      codEnabled: delivery.codEnabled,
      codAmount: delivery.codAmount,
      codPayer: delivery.codPayer,
      codCollectedAt: delivery.codCollectedAt?.toISOString() ?? null,
      packages: delivery.packages.map((item) => ({
        ...item,
        photoUrl: item.photoFileId ? (photoUrls.get(item.photoFileId) ?? null) : null,
      })),
      proofOfDelivery: delivery.proof
        ? {
            photoUrl: proofUrl,
            recipientName: delivery.proof.recipientName,
            note: delivery.proof.note,
            capturedAt: delivery.proof.capturedAt.toISOString(),
          }
        : null,
      rating: delivery.rating
        ? { ...delivery.rating, createdAt: delivery.rating.createdAt.toISOString() }
        : null,
      cancelledByType: delivery.cancelledByType,
      cancelReason: delivery.cancelReason,
      timeline: delivery.statusHistory.map((entry) => this.toTimelineEntry(entry)),
      offers: delivery.assignments.map((assignment) => ({
        driverId: assignment.driver.id,
        driverName: assignment.driver.fullName,
        status: assignment.status,
        round: assignment.round,
        distanceToPickupMeters: assignment.distanceToPickupMeters,
        declineReason: assignment.declineReason,
        offeredAt: assignment.offeredAt.toISOString(),
        respondedAt: assignment.respondedAt?.toISOString() ?? null,
      })),
    };
  }

  /**
   * The status history on its own.
   *
   * Support opens this far more often than the full detail view, and it is a
   * fraction of the payload.
   */
  async timeline(deliveryId: string): Promise<AdminDeliveryTimelineEntryDto[]> {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      select: {
        statusHistory: {
          orderBy: { createdAt: 'asc' },
          select: {
            fromStatus: true,
            toStatus: true,
            actorType: true,
            reason: true,
            metadata: true,
            createdAt: true,
            actor: {
              select: {
                adminProfile: { select: { fullName: true } },
                customerProfile: { select: { fullName: true } },
                driverProfile: { select: { fullName: true } },
              },
            },
          },
        },
      },
    });

    if (!delivery) {
      throw AppException.notFound(ResponseCode.DELIVERY_NOT_FOUND);
    }

    return delivery.statusHistory.map((entry) => this.toTimelineEntry(entry));
  }

  /**
   * Cancels on the customer's behalf.
   *
   * An operator can do this at any point before delivery, including after
   * pickup — that case is exactly why the customer cannot do it themselves and
   * has to call support.
   */
  async cancel(
    actorUserId: string,
    deliveryId: string,
    dto: AdminCancelDeliveryDto,
  ): Promise<AdminDeliveryDetailDto> {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      select: { id: true, status: true, bookingCode: true, driverId: true },
    });

    if (!delivery) throw AppException.notFound(ResponseCode.DELIVERY_NOT_FOUND);

    if (delivery.status === DeliveryStatus.DELIVERED) {
      throw AppException.conflict(ResponseCode.DELIVERY_ALREADY_COMPLETED);
    }
    if (delivery.status === DeliveryStatus.CANCELLED) {
      throw AppException.conflict(ResponseCode.DELIVERY_ALREADY_CANCELLED);
    }

    const result = await this.prisma.$transaction((tx) =>
      this.state.transition(tx, {
        deliveryId,
        to: DeliveryStatus.CANCELLED,
        actorType: ActorType.ADMIN,
        actorUserId,
        reason: dto.reason,
        data: {
          cancelledByType: ActorType.ADMIN,
          cancelledByUserId: actorUserId,
          cancelReason: dto.reason,
        },
      }),
    );

    await this.matching.cancelOutstandingOffers(deliveryId);
    await this.state.publish(result);

    await this.audit.record({
      actorUserId,
      action: 'delivery.cancel',
      entityType: 'Delivery',
      entityId: deliveryId,
      summary: `Cancelled ${delivery.bookingCode}: ${dto.reason}`,
      before: { status: delivery.status, driverId: delivery.driverId },
      after: { status: DeliveryStatus.CANCELLED },
    });

    return this.findOne(deliveryId);
  }

  /**
   * Takes the delivery off its driver and puts it back in the pool.
   *
   * The customer's booking survives — this is for an unreachable driver, not a
   * change of mind. Refused once the package has been collected, because the
   * goods are physically with someone.
   */
  async reassign(
    actorUserId: string,
    deliveryId: string,
    dto: AdminReassignDeliveryDto,
  ): Promise<AdminDeliveryDetailDto> {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      select: { id: true, status: true, bookingCode: true, driverId: true },
    });

    if (!delivery) throw AppException.notFound(ResponseCode.DELIVERY_NOT_FOUND);

    const reassignable: DeliveryStatus[] = [DeliveryStatus.DRIVER_ASSIGNED, DeliveryStatus.ARRIVED_PICKUP];
    if (!reassignable.includes(delivery.status)) {
      throw AppException.unprocessable(
        ResponseCode.DELIVERY_NOT_REASSIGNABLE,
        delivery.status === DeliveryStatus.PICKED_UP ||
        delivery.status === DeliveryStatus.IN_TRANSIT ||
        delivery.status === DeliveryStatus.ARRIVED_DROPOFF
          ? 'The driver already has the package. Cancel the delivery instead.'
          : undefined,
      );
    }

    const previousDriverId = delivery.driverId;

    const result = await this.prisma.$transaction(async (tx) => {
      const transition = await this.state.transition(tx, {
        deliveryId,
        to: DeliveryStatus.SEARCHING_DRIVER,
        actorType: ActorType.ADMIN,
        actorUserId,
        reason: dto.reason,
        data: {
          driverId: null,
          driverVehicleId: null,
          assignedAt: null,
          arrivedPickupAt: null,
          searchStartedAt: new Date(),
        },
      });

      // Marked DECLINED so the matcher does not immediately offer it back to
      // the same driver.
      await tx.deliveryAssignment.updateMany({
        where: { deliveryId, status: AssignmentStatus.ACCEPTED },
        data: { status: AssignmentStatus.DECLINED, declineReason: dto.reason, respondedAt: new Date() },
      });

      return transition;
    });

    // Frees the driver for other work. `publish` then re-announces the
    // delivery as confirmed, which puts it back into the matching rounds.
    if (previousDriverId) {
      await this.availability.setBusy(previousDriverId, false);
    }

    await this.state.publish(result);

    await this.audit.record({
      actorUserId,
      action: 'delivery.reassign',
      entityType: 'Delivery',
      entityId: deliveryId,
      summary: `Returned ${delivery.bookingCode} to matching: ${dto.reason}`,
      before: { status: delivery.status, driverId: previousDriverId },
      after: { status: DeliveryStatus.SEARCHING_DRIVER, driverId: null },
    });

    return this.findOne(deliveryId);
  }

  /**
   * Everything currently in motion, with the drivers' live positions — the
   * operations map. Positions come from Redis, so this costs no database reads
   * beyond the deliveries themselves.
   */
  async live(): Promise<AdminLiveDeliveryDto[]> {
    const deliveries = await this.prisma.delivery.findMany({
      where: { status: { in: [...ACTIVE_DELIVERY_STATUSES] }, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      take: 200,
      select: {
        id: true,
        bookingCode: true,
        status: true,
        pickupLatitude: true,
        pickupLongitude: true,
        dropoffLatitude: true,
        dropoffLongitude: true,
        confirmedAt: true,
        createdAt: true,
        driverId: true,
        driver: { select: { fullName: true } },
      },
    });

    // One call for every driver on the map, rather than one call per row on a
    // screen built to be polled.
    const fixes = await this.presence.getLocations(
      deliveries.map((delivery) => delivery.driverId).filter((id): id is string => id !== null),
    );

    return deliveries.map((delivery) => {
      const fix = delivery.driverId ? (fixes.get(delivery.driverId) ?? null) : null;

      return {
        id: delivery.id,
        bookingCode: delivery.bookingCode,
        status: delivery.status,
        pickupLatitude: delivery.pickupLatitude,
        pickupLongitude: delivery.pickupLongitude,
        dropoffLatitude: delivery.dropoffLatitude,
        dropoffLongitude: delivery.dropoffLongitude,
        driverName: delivery.driver?.fullName ?? null,
        driverLatitude: fix?.latitude ?? null,
        driverLongitude: fix?.longitude ?? null,
        waitingMinutes: this.waitingMinutes(delivery),
      };
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────

  /** Exposed so an export covers exactly the rows the screen is showing. */
  buildWhere(query: AdminDeliveryQueryDto): Prisma.DeliveryWhereInput {
    const stalledSince =
      query.stalledForMinutes !== undefined
        ? new Date(Date.now() - query.stalledForMinutes * 60_000)
        : undefined;

    return {
      deletedAt: null,
      ...(query.status?.length ? { status: { in: query.status } } : {}),
      ...(query.paymentStatus ? { paymentStatus: query.paymentStatus } : {}),
      ...(query.paymentMethod ? { paymentMethod: query.paymentMethod } : {}),
      ...(query.driverId ? { driverId: query.driverId } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.vehicleTypeId ? { vehicleTypeId: query.vehicleTypeId } : {}),
      ...(query.dateFrom || query.dateTo
        ? {
            createdAt: {
              ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
              ...(query.dateTo ? { lte: this.endOfDay(query.dateTo) } : {}),
            },
          }
        : {}),
      // "Waiting too long" means still searching and confirmed before the cutoff.
      ...(stalledSince
        ? { status: DeliveryStatus.SEARCHING_DRIVER, confirmedAt: { lte: stalledSince } }
        : {}),
      ...(query.search
        ? {
            OR: [
              { bookingCode: { contains: query.search, mode: 'insensitive' } },
              { pickupAddress: { contains: query.search, mode: 'insensitive' } },
              { dropoffAddress: { contains: query.search, mode: 'insensitive' } },
              { pickupContactPhone: { contains: query.search } },
              { dropoffContactPhone: { contains: query.search } },
              { customer: { user: { phone: { contains: query.search } } } },
              { driver: { user: { phone: { contains: query.search } } } },
            ],
          }
        : {}),
    };
  }

  private toRow(
    row: Prisma.DeliveryGetPayload<{ select: typeof listSelect }>,
    avatars: Map<string, string>,
  ): AdminDeliveryRowDto {
    return {
      id: row.id,
      bookingCode: row.bookingCode,
      status: row.status,
      pickupAddress: row.pickupAddress,
      dropoffAddress: row.dropoffAddress,
      vehicleTypeCode: row.vehicleType.code,
      distanceMeters: row.distanceMeters,
      totalAmount: row.totalAmount,
      commissionAmount: row.commissionAmount,
      driverEarningAmount: row.driverEarningAmount,
      currency: row.currency,
      paymentMethod: row.paymentMethod,
      paymentStatus: row.paymentStatus,
      customer: row.customer
        ? {
            id: row.customer.id,
            fullName: row.customer.fullName,
            phone: row.customer.user.phone,
            avatarUrl: row.customer.avatarFileId ? (avatars.get(row.customer.avatarFileId) ?? null) : null,
          }
        : null,
      driver: row.driver
        ? {
            id: row.driver.id,
            fullName: row.driver.fullName,
            phone: row.driver.user.phone,
            avatarUrl: row.driver.avatarFileId ? (avatars.get(row.driver.avatarFileId) ?? null) : null,
          }
        : null,
      waitingMinutes: this.waitingMinutes(row),
      createdAt: row.createdAt.toISOString(),
      deliveredAt: row.deliveredAt?.toISOString() ?? null,
    };
  }

  private toTimelineEntry(entry: {
    fromStatus: DeliveryStatus | null;
    toStatus: DeliveryStatus;
    actorType: ActorType;
    reason: string | null;
    metadata: unknown;
    createdAt: Date;
    actor: {
      adminProfile: { fullName: string } | null;
      customerProfile: { fullName: string } | null;
      driverProfile: { fullName: string } | null;
    } | null;
  }): AdminDeliveryTimelineEntryDto {
    return {
      fromStatus: entry.fromStatus,
      toStatus: entry.toStatus,
      actorType: entry.actorType,
      actorName:
        entry.actor?.adminProfile?.fullName ??
        entry.actor?.customerProfile?.fullName ??
        entry.actor?.driverProfile?.fullName ??
        null,
      reason: entry.reason,
      metadata: entry.metadata as Record<string, unknown> | null,
      at: entry.createdAt.toISOString(),
    };
  }

  /** How long a delivery has been looking for a driver. Zero once it has one. */
  private waitingMinutes(delivery: { status: DeliveryStatus; confirmedAt: Date | null; createdAt: Date }): number {
    if (delivery.status !== DeliveryStatus.SEARCHING_DRIVER) return 0;
    const since = delivery.confirmedAt ?? delivery.createdAt;
    return Math.max(0, Math.round((Date.now() - since.getTime()) / 60_000));
  }

  private endOfDay(date: string): Date {
    const parsed = new Date(date);
    parsed.setUTCHours(23, 59, 59, 999);
    return parsed;
  }
}
