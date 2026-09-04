import { Injectable, Logger } from '@nestjs/common';
import { IN_FLIGHT_DELIVERY_STATUSES } from '../../../common/constants/delivery-status.js';
import { ResponseCode } from '../../../common/constants/response-codes.js';
import { AppException } from '../../../common/exceptions/app.exception.js';
import type { PaginatedResult } from '../../../common/interfaces/paginated.interface.js';
import { PaginationUtil } from '../../../common/utils/pagination.util.js';
import { PrismaService } from '../../../database/prisma.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import {
  DocumentReviewStatus,
  DriverApprovalStatus,
  DriverAvailabilityStatus,
  DriverDocumentType,
  NotificationType,
  UserStatus,
} from '../../../generated/prisma/enums.js';
import { TokenService } from '../../auth/services/token.service.js';
import { DriverPresenceService } from '../../driver-presence/driver-presence.service.js';
import { DOCUMENT_LABELS, REQUIRED_DRIVER_DOCUMENTS } from '../../drivers/driver.constants.js';
import { DriverReadinessService } from '../../drivers/driver-readiness.service.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { FileUrlService } from '../../uploads/file-url.service.js';
import { UsersService } from '../../users/users.service.js';
import { AuditService } from '../audit.service.js';
import type {
  AdminAssignZonesDto,
  AdminDriverDetailDto,
  AdminDriverDocumentDto,
  AdminDriverQueryDto,
  AdminDriverRowDto,
  AdminReasonDto,
  AdminReviewDocumentDto,
  AdminUpdateDriverDto,
  AdminZoneSummaryDto,
} from '../dto/admin-driver.dto.js';

const REQUIRED = new Set<DriverDocumentType>(REQUIRED_DRIVER_DOCUMENTS);

const listSelect = {
  id: true,
  userId: true,
  fullName: true,
  avatarFileId: true,
  approvalStatus: true,
  ratingAverage: true,
  ratingCount: true,
  completedDeliveries: true,
  cancelledDeliveries: true,
  offeredJobs: true,
  acceptedJobs: true,
  createdAt: true,
  user: { select: { phone: true, status: true } },
  availability: { select: { status: true } },
  vehicles: {
    where: { isPrimary: true, deletedAt: null },
    take: 1,
    select: { plateNumber: true, vehicleType: { select: { code: true } } },
  },
  zones: { select: { zone: { select: { id: true, code: true, name: true } } } },
  _count: { select: { documents: { where: { status: DocumentReviewStatus.PENDING } } } },
} as const;

/**
 * Drivers, as the people who admit them to the platform see them.
 *
 * Approval, rejection and suspension all change what a driver may do, so each
 * one goes through the same three steps: write the decision, make it take
 * effect immediately (drop them from the matching pool, invalidate the cached
 * principal), and tell the driver why. None of that is optional — a driver who
 * is suspended in the database but still holding jobs in Redis is worse than
 * one who was never suspended.
 */
@Injectable()
export class AdminDriversService {
  private readonly logger = new Logger(AdminDriversService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: DriverPresenceService,
    private readonly readiness: DriverReadinessService,
    private readonly notifications: NotificationsService,
    private readonly fileUrls: FileUrlService,
    private readonly users: UsersService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  async findAll(query: AdminDriverQueryDto): Promise<PaginatedResult<AdminDriverRowDto>> {
    const where = this.buildWhere(query);

    const [rows, total] = await Promise.all([
      this.prisma.driverProfile.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
        select: listSelect,
      }),
      this.prisma.driverProfile.count({ where }),
    ]);

    const avatars = await this.fileUrls.resolveMany(rows.map((row) => row.avatarFileId));
    const online = await Promise.all(rows.map((row) => this.presence.isOnline(row.id)));

    return PaginationUtil.paginate(
      rows.map((row, index) => this.toRow(row, avatars, online[index])),
      query.page,
      query.limit,
      total,
    );
  }

  async findOne(driverId: string): Promise<AdminDriverDetailDto> {
    const driver = await this.prisma.driverProfile.findFirst({
      where: { id: driverId, deletedAt: null },
      select: {
        ...listSelect,
        approvedAt: true,
        rejectedReason: true,
        suspendedReason: true,
        user: {
          select: {
            id: true,
            phone: true,
            email: true,
            status: true,
            lastLoginAt: true,
            wallets: {
              select: { currency: true, balance: true, reservedBalance: true },
              orderBy: { currency: 'asc' },
            },
          },
        },
        vehicles: {
          where: { deletedAt: null },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }],
          select: {
            id: true,
            plateNumber: true,
            brand: true,
            model: true,
            color: true,
            year: true,
            photoFileId: true,
            isPrimary: true,
            status: true,
            vehicleType: { select: { code: true, name: true } },
          },
        },
        documents: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            type: true,
            status: true,
            fileId: true,
            reviewNote: true,
            reviewedAt: true,
            expiresAt: true,
            createdAt: true,
            reviewedBy: { select: { adminProfile: { select: { fullName: true } } } },
          },
        },
      },
    });

    if (!driver) throw AppException.notFound(ResponseCode.DRIVER_NOT_FOUND);

    const [avatars, readiness, fix, activeDeliveries, documentUrls, isOnline] = await Promise.all([
      this.fileUrls.resolveMany([driver.avatarFileId]),
      this.readiness.evaluate(driverId),
      this.presence.getLocation(driverId),
      this.prisma.delivery.count({
        where: { driverId, status: { in: [...IN_FLIGHT_DELIVERY_STATUSES] } },
      }),
      this.fileUrls.resolveMany(driver.documents.map((document) => document.fileId)),
      this.presence.isOnline(driverId),
    ]);

    const vehiclePhotos = await this.fileUrls.resolveMany(
      driver.vehicles.map((vehicle) => vehicle.photoFileId),
    );

    return {
      ...this.toRow(driver, avatars, isOnline),
      email: driver.user.email,
      approvedAt: driver.approvedAt?.toISOString() ?? null,
      rejectedReason: driver.rejectedReason,
      suspendedReason: driver.suspendedReason,
      lastLoginAt: driver.user.lastLoginAt?.toISOString() ?? null,
      canGoOnline: readiness.canGoOnline,
      blockers: readiness.blockers,
      vehicles: driver.vehicles.map((vehicle) => ({
        id: vehicle.id,
        vehicleTypeCode: vehicle.vehicleType.code,
        vehicleTypeName: vehicle.vehicleType.name,
        plateNumber: vehicle.plateNumber,
        brand: vehicle.brand,
        model: vehicle.model,
        color: vehicle.color,
        year: vehicle.year,
        photoUrl: vehicle.photoFileId ? (vehiclePhotos.get(vehicle.photoFileId) ?? null) : null,
        isPrimary: vehicle.isPrimary,
        status: vehicle.status,
      })),
      documents: driver.documents.map((document) => this.toDocument(document, documentUrls)),
      wallets: driver.user.wallets.map((wallet) => ({
        currency: wallet.currency,
        balance: wallet.balance,
        reservedBalance: wallet.reservedBalance,
        availableBalance: wallet.balance - wallet.reservedBalance,
      })),
      lastLatitude: fix?.latitude ?? null,
      lastLongitude: fix?.longitude ?? null,
      lastSeenAt: fix?.recordedAt ?? null,
      activeDeliveries,
    };
  }

  // ── Approval ───────────────────────────────────────────────────────────

  /**
   * Admits a driver to the platform.
   *
   * Refused while a required document is unreviewed or rejected: approving a
   * driver whose licence nobody has looked at is the one mistake this screen
   * exists to prevent, and the readiness check would silently keep them
   * offline anyway, which reads to everyone as a bug.
   */
  async approve(actorUserId: string, driverId: string): Promise<AdminDriverDetailDto> {
    const driver = await this.load(driverId);

    if (driver.approvalStatus === DriverApprovalStatus.ACTIVE) {
      throw AppException.conflict(ResponseCode.DRIVER_ALREADY_APPROVED);
    }

    const approved = await this.prisma.driverDocument.findMany({
      where: { driverId, status: DocumentReviewStatus.APPROVED },
      select: { type: true },
    });
    const approvedTypes = new Set(approved.map((document) => document.type));
    const missing = REQUIRED_DRIVER_DOCUMENTS.filter((type) => !approvedTypes.has(type));

    if (missing.length > 0) {
      throw AppException.unprocessable(
        ResponseCode.DRIVER_DOCUMENTS_INCOMPLETE,
        `Review these documents first: ${missing.map((type) => DOCUMENT_LABELS[type]).join(', ')}.`,
      );
    }

    await this.prisma.driverProfile.update({
      where: { id: driverId },
      data: {
        approvalStatus: DriverApprovalStatus.ACTIVE,
        approvedAt: new Date(),
        rejectedReason: null,
        suspendedReason: null,
      },
    });

    // An approved driver whose account was suspended alongside can sign in again.
    await this.prisma.user.update({
      where: { id: driver.userId },
      data: { status: UserStatus.ACTIVE, suspendedReason: null },
    });
    await this.users.invalidateAuthContext(driver.userId);

    await this.notify(
      driver.userId,
      'Your driver account is approved',
      'You can go online and start accepting deliveries.',
    );

    await this.audit.record({
      actorUserId,
      action: 'driver.approve',
      entityType: 'DriverProfile',
      entityId: driverId,
      summary: `Approved ${driver.fullName}`,
      before: { approvalStatus: driver.approvalStatus },
      after: { approvalStatus: DriverApprovalStatus.ACTIVE },
    });

    return this.findOne(driverId);
  }

  async reject(actorUserId: string, driverId: string, dto: AdminReasonDto): Promise<AdminDriverDetailDto> {
    const driver = await this.load(driverId);

    await this.prisma.driverProfile.update({
      where: { id: driverId },
      data: { approvalStatus: DriverApprovalStatus.REJECTED, rejectedReason: dto.reason, approvedAt: null },
    });

    await this.forceOffline(driverId);

    await this.notify(
      driver.userId,
      'Your driver application was not approved',
      dto.reason,
    );

    await this.audit.record({
      actorUserId,
      action: 'driver.reject',
      entityType: 'DriverProfile',
      entityId: driverId,
      summary: `Rejected ${driver.fullName}: ${dto.reason}`,
      before: { approvalStatus: driver.approvalStatus },
      after: { approvalStatus: DriverApprovalStatus.REJECTED, reason: dto.reason },
    });

    return this.findOne(driverId);
  }

  /**
   * Stops a driver working, and stops them signing in.
   *
   * Refused while they are holding a delivery: the package is physically with
   * them, and cutting their access would strand a customer's goods with
   * someone who can no longer open the app. The operator reassigns or cancels
   * first, which is a decision a person should make deliberately.
   */
  async suspend(actorUserId: string, driverId: string, dto: AdminReasonDto): Promise<AdminDriverDetailDto> {
    const driver = await this.load(driverId);

    const active = await this.prisma.delivery.count({
      where: { driverId, status: { in: [...IN_FLIGHT_DELIVERY_STATUSES] } },
    });

    if (active > 0) {
      throw AppException.conflict(
        ResponseCode.DRIVER_HAS_ACTIVE_DELIVERY,
        `This driver is holding ${active} active ${active === 1 ? 'delivery' : 'deliveries'}. Reassign or cancel ${active === 1 ? 'it' : 'them'} first.`,
      );
    }

    await this.prisma.$transaction([
      this.prisma.driverProfile.update({
        where: { id: driverId },
        data: { approvalStatus: DriverApprovalStatus.SUSPENDED, suspendedReason: dto.reason },
      }),
      this.prisma.user.update({
        where: { id: driver.userId },
        data: { status: UserStatus.SUSPENDED, suspendedReason: dto.reason },
      }),
    ]);

    // Out of the matching pool, out of every open session, and out of the
    // cached principal — all three, or the suspension is only on paper.
    await this.forceOffline(driverId);
    await this.tokens.revokeAllSessions(driver.userId);
    await this.users.invalidateAuthContext(driver.userId);

    await this.notify(driver.userId, 'Your driver account is suspended', dto.reason);

    await this.audit.record({
      actorUserId,
      action: 'driver.suspend',
      entityType: 'DriverProfile',
      entityId: driverId,
      summary: `Suspended ${driver.fullName}: ${dto.reason}`,
      before: { approvalStatus: driver.approvalStatus, accountStatus: driver.user.status },
      after: { approvalStatus: DriverApprovalStatus.SUSPENDED, accountStatus: UserStatus.SUSPENDED },
    });

    return this.findOne(driverId);
  }

  async reinstate(actorUserId: string, driverId: string): Promise<AdminDriverDetailDto> {
    const driver = await this.load(driverId);

    if (driver.approvalStatus !== DriverApprovalStatus.SUSPENDED) {
      throw AppException.conflict(
        ResponseCode.DRIVER_NOT_SUSPENDED,
        'Only a suspended driver can be reinstated.',
      );
    }

    await this.prisma.$transaction([
      this.prisma.driverProfile.update({
        where: { id: driverId },
        data: { approvalStatus: DriverApprovalStatus.ACTIVE, suspendedReason: null },
      }),
      this.prisma.user.update({
        where: { id: driver.userId },
        data: { status: UserStatus.ACTIVE, suspendedReason: null },
      }),
    ]);

    await this.users.invalidateAuthContext(driver.userId);

    await this.notify(
      driver.userId,
      'Your driver account is active again',
      'You can sign in and go online.',
    );

    await this.audit.record({
      actorUserId,
      action: 'driver.reinstate',
      entityType: 'DriverProfile',
      entityId: driverId,
      summary: `Reinstated ${driver.fullName}`,
      before: { approvalStatus: DriverApprovalStatus.SUSPENDED },
      after: { approvalStatus: DriverApprovalStatus.ACTIVE },
    });

    return this.findOne(driverId);
  }

  async update(
    actorUserId: string,
    driverId: string,
    dto: AdminUpdateDriverDto,
  ): Promise<AdminDriverDetailDto> {
    const driver = await this.load(driverId);

    if (dto.fullName === undefined) return this.findOne(driverId);

    await this.prisma.driverProfile.update({
      where: { id: driverId },
      data: { fullName: dto.fullName },
    });

    await this.audit.record({
      actorUserId,
      action: 'driver.update',
      entityType: 'DriverProfile',
      entityId: driverId,
      summary: `Renamed ${driver.fullName} to ${dto.fullName}`,
      before: { fullName: driver.fullName },
      after: { fullName: dto.fullName },
    });

    return this.findOne(driverId);
  }

  // ── Documents ──────────────────────────────────────────────────────────

  async documents(driverId: string): Promise<AdminDriverDocumentDto[]> {
    await this.load(driverId);

    const documents = await this.prisma.driverDocument.findMany({
      where: { driverId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        type: true,
        status: true,
        fileId: true,
        reviewNote: true,
        reviewedAt: true,
        expiresAt: true,
        createdAt: true,
        reviewedBy: { select: { adminProfile: { select: { fullName: true } } } },
      },
    });

    const urls = await this.fileUrls.resolveMany(documents.map((document) => document.fileId));
    return documents.map((document) => this.toDocument(document, urls));
  }

  /**
   * Accepts or refuses one uploaded document.
   *
   * Rejecting a required document from an already-active driver takes them off
   * the road immediately — readiness is re-evaluated rather than assumed, so
   * a driver whose licence has just been refused cannot keep working until
   * someone remembers to suspend them.
   */
  async reviewDocument(
    actorUserId: string,
    driverId: string,
    documentId: string,
    dto: AdminReviewDocumentDto,
  ): Promise<AdminDriverDocumentDto[]> {
    const driver = await this.load(driverId);

    const document = await this.prisma.driverDocument.findFirst({
      where: { id: documentId, driverId },
      select: { id: true, type: true, status: true },
    });

    if (!document) throw AppException.notFound(ResponseCode.DOCUMENT_NOT_FOUND);

    if (dto.status === DocumentReviewStatus.REJECTED && !dto.note?.trim()) {
      throw AppException.badRequest(
        ResponseCode.VALIDATION_ERROR,
        'Tell the driver why the document was rejected.',
      );
    }

    await this.prisma.driverDocument.update({
      where: { id: documentId },
      data: {
        status: dto.status,
        reviewNote: dto.note ?? null,
        reviewedByUserId: actorUserId,
        reviewedAt: new Date(),
      },
    });

    const label = DOCUMENT_LABELS[document.type];

    if (dto.status === DocumentReviewStatus.REJECTED) {
      const readiness = await this.readiness.evaluate(driverId);
      if (!readiness.canGoOnline) await this.forceOffline(driverId);
    }

    await this.notifications.create({
      userId: driver.userId,
      type: NotificationType.DOCUMENT_REVIEWED,
      title: dto.status === DocumentReviewStatus.APPROVED ? `${label} approved` : `${label} rejected`,
      body:
        dto.status === DocumentReviewStatus.APPROVED
          ? 'Your document has been accepted.'
          : (dto.note as string),
      data: { documentId, type: document.type, status: dto.status },
    });

    await this.audit.record({
      actorUserId,
      action: 'driver.document.review',
      entityType: 'DriverDocument',
      entityId: documentId,
      summary: `${dto.status === DocumentReviewStatus.APPROVED ? 'Approved' : 'Rejected'} ${label} for ${driver.fullName}`,
      before: { status: document.status },
      after: { status: dto.status, note: dto.note ?? null },
    });

    return this.documents(driverId);
  }

  // ── Zones ──────────────────────────────────────────────────────────────

  /** Replaces the driver's zone assignments outright. */
  async assignZones(
    actorUserId: string,
    driverId: string,
    dto: AdminAssignZonesDto,
  ): Promise<AdminZoneSummaryDto[]> {
    const driver = await this.load(driverId);
    const wanted = [...new Set(dto.zoneIds)];

    const zones = await this.prisma.zone.findMany({
      where: { id: { in: wanted }, deletedAt: null },
      select: { id: true, code: true, name: true },
    });

    if (zones.length !== wanted.length) {
      throw AppException.notFound(ResponseCode.ZONE_NOT_FOUND, 'One or more zones do not exist.');
    }

    const before = await this.prisma.driverZone.findMany({
      where: { driverId },
      select: { zoneId: true },
    });

    await this.prisma.$transaction([
      this.prisma.driverZone.deleteMany({ where: { driverId } }),
      this.prisma.driverZone.createMany({
        data: zones.map((zone) => ({ driverId, zoneId: zone.id })),
      }),
    ]);

    await this.audit.record({
      actorUserId,
      action: 'driver.zones.assign',
      entityType: 'DriverProfile',
      entityId: driverId,
      summary: `Set ${driver.fullName}'s zones to ${zones.map((zone) => zone.code).join(', ') || 'none'}`,
      before: { zoneIds: before.map((row) => row.zoneId) },
      after: { zoneIds: zones.map((zone) => zone.id) },
    });

    return zones;
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async load(driverId: string) {
    const driver = await this.prisma.driverProfile.findFirst({
      where: { id: driverId, deletedAt: null },
      select: {
        id: true,
        userId: true,
        fullName: true,
        approvalStatus: true,
        user: { select: { status: true } },
      },
    });

    if (!driver) throw AppException.notFound(ResponseCode.DRIVER_NOT_FOUND);
    return driver;
  }

  /** Takes a driver out of the matching pool and marks them offline. */
  private async forceOffline(driverId: string): Promise<void> {
    const vehicles = await this.prisma.driverVehicle.findMany({
      where: { driverId, deletedAt: null },
      select: { vehicleType: { select: { code: true } } },
    });

    // Every vehicle type they could be indexed under, not just the primary —
    // a driver who switched vehicles would otherwise stay in the old index.
    for (const vehicle of vehicles) {
      await this.presence.goOffline(driverId, vehicle.vehicleType.code);
    }

    await this.prisma.driverAvailability.updateMany({
      where: { driverId, status: { not: DriverAvailabilityStatus.OFFLINE } },
      data: { status: DriverAvailabilityStatus.OFFLINE, lastOfflineAt: new Date() },
    });
  }

  private async notify(userId: string, title: string, body: string): Promise<void> {
    await this.notifications.create({
      userId,
      type: NotificationType.ACCOUNT_STATUS_CHANGED,
      title,
      body,
    });
  }

  /** Exposed so an export covers exactly the rows the screen is showing. */
  buildWhere(query: AdminDriverQueryDto): Prisma.DriverProfileWhereInput {
    return {
      deletedAt: null,
      ...(query.approvalStatus?.length ? { approvalStatus: { in: query.approvalStatus } } : {}),
      ...(query.availability ? { availability: { status: query.availability } } : {}),
      ...(query.zoneId ? { zones: { some: { zoneId: query.zoneId } } } : {}),
      ...(query.vehicleTypeId
        ? { vehicles: { some: { vehicleTypeId: query.vehicleTypeId, isPrimary: true, deletedAt: null } } }
        : {}),
      ...(query.awaitingReview
        ? { documents: { some: { status: DocumentReviewStatus.PENDING } } }
        : {}),
      ...(query.dateFrom || query.dateTo
        ? {
            createdAt: {
              ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
              ...(query.dateTo ? { lte: this.endOfDay(query.dateTo) } : {}),
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              { fullName: { contains: query.search, mode: 'insensitive' } },
              { user: { phone: { contains: query.search } } },
              { vehicles: { some: { plateNumber: { contains: query.search, mode: 'insensitive' } } } },
            ],
          }
        : {}),
    };
  }

  private toRow(
    row: Prisma.DriverProfileGetPayload<{ select: typeof listSelect }>,
    avatars: Map<string, string>,
    onlineNow: boolean,
  ): AdminDriverRowDto {
    const vehicle = row.vehicles[0];

    return {
      id: row.id,
      userId: row.userId,
      fullName: row.fullName,
      phone: row.user.phone,
      avatarUrl: row.avatarFileId ? (avatars.get(row.avatarFileId) ?? null) : null,
      approvalStatus: row.approvalStatus,
      accountStatus: row.user.status,
      availability: row.availability?.status ?? DriverAvailabilityStatus.OFFLINE,
      onlineNow,
      plateNumber: vehicle?.plateNumber ?? null,
      vehicleTypeCode: vehicle?.vehicleType.code ?? null,
      ratingAverage: Number(row.ratingAverage),
      ratingCount: row.ratingCount,
      completedDeliveries: row.completedDeliveries,
      cancelledDeliveries: row.cancelledDeliveries,
      acceptanceRateBps:
        row.offeredJobs === 0 ? 0 : Math.round((row.acceptedJobs / row.offeredJobs) * 10_000),
      zones: row.zones.map((assignment) => assignment.zone),
      documentsAwaitingReview: row._count.documents,
      joinedAt: row.createdAt.toISOString(),
    };
  }

  private toDocument(
    document: {
      id: string;
      type: DriverDocumentType;
      status: DocumentReviewStatus;
      fileId: string;
      reviewNote: string | null;
      reviewedAt: Date | null;
      expiresAt: Date | null;
      createdAt: Date;
      reviewedBy: { adminProfile: { fullName: string } | null } | null;
    },
    urls: Map<string, string>,
  ): AdminDriverDocumentDto {
    return {
      id: document.id,
      type: document.type,
      label: DOCUMENT_LABELS[document.type],
      status: document.status,
      required: REQUIRED.has(document.type),
      fileUrl: urls.get(document.fileId) ?? null,
      reviewNote: document.reviewNote,
      reviewedByName: document.reviewedBy?.adminProfile?.fullName ?? null,
      reviewedAt: document.reviewedAt?.toISOString() ?? null,
      expiresAt: document.expiresAt?.toISOString() ?? null,
      uploadedAt: document.createdAt.toISOString(),
    };
  }

  private endOfDay(date: string): Date {
    const parsed = new Date(date);
    parsed.setUTCHours(23, 59, 59, 999);
    return parsed;
  }
}
