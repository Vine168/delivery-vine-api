import { Injectable } from '@nestjs/common';
import { ACTIVE_DELIVERY_STATUSES } from '../../../common/constants/delivery-status.js';
import { ResponseCode } from '../../../common/constants/response-codes.js';
import { AppException } from '../../../common/exceptions/app.exception.js';
import type { PaginatedResult } from '../../../common/interfaces/paginated.interface.js';
import { PaginationUtil } from '../../../common/utils/pagination.util.js';
import { PrismaService } from '../../../database/prisma.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { DeliveryStatus, NotificationType, UserStatus } from '../../../generated/prisma/enums.js';
import { TokenService } from '../../auth/services/token.service.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { FileUrlService } from '../../uploads/file-url.service.js';
import { UsersService } from '../../users/users.service.js';
import { AuditService } from '../audit.service.js';
import type {
  AdminCustomerDetailDto,
  AdminCustomerQueryDto,
  AdminCustomerRowDto,
} from '../dto/admin-customer.dto.js';
import type { AdminReasonDto } from '../dto/admin-driver.dto.js';

const listSelect = {
  id: true,
  userId: true,
  fullName: true,
  avatarFileId: true,
  createdAt: true,
  user: { select: { phone: true, status: true } },
  _count: { select: { deliveries: { where: { status: { not: DeliveryStatus.DRAFT } } } } },
  deliveries: {
    where: { status: { not: DeliveryStatus.DRAFT } },
    orderBy: { createdAt: 'desc' },
    take: 1,
    select: { createdAt: true },
  },
} as const;

/**
 * Customer accounts, for support.
 *
 * Deliberately read-mostly: an operator can see who someone is and stop them
 * using the platform, but cannot edit their profile or their saved addresses.
 * Correcting a customer's own data on their behalf is how support desks end up
 * accountable for changes nobody can explain.
 */
@Injectable()
export class AdminCustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly fileUrls: FileUrlService,
    private readonly users: UsersService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  async findAll(query: AdminCustomerQueryDto): Promise<PaginatedResult<AdminCustomerRowDto>> {
    const where = this.buildWhere(query);

    const [rows, total] = await Promise.all([
      this.prisma.customerProfile.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
        select: listSelect,
      }),
      this.prisma.customerProfile.count({ where }),
    ]);

    const avatars = await this.fileUrls.resolveMany(rows.map((row) => row.avatarFileId));

    return PaginationUtil.paginate(
      rows.map((row) => this.toRow(row, avatars)),
      query.page,
      query.limit,
      total,
    );
  }

  async findOne(customerId: string): Promise<AdminCustomerDetailDto> {
    const customer = await this.prisma.customerProfile.findUnique({
      where: { id: customerId },
      select: {
        ...listSelect,
        user: {
          select: { phone: true, email: true, status: true, suspendedReason: true, lastLoginAt: true },
        },
        addresses: {
          where: { deletedAt: null },
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
          select: {
            id: true,
            label: true,
            addressLine: true,
            latitude: true,
            longitude: true,
            isDefault: true,
          },
        },
        _count: { select: { favoriteDrivers: true } },
      },
    });

    if (!customer) throw AppException.notFound(ResponseCode.CUSTOMER_NOT_FOUND);

    const [avatars, counts, spend, bookings, latest] = await Promise.all([
      this.fileUrls.resolveMany([customer.avatarFileId]),
      this.prisma.delivery.groupBy({
        by: ['status'],
        where: { customerId, status: { not: DeliveryStatus.DRAFT } },
        _count: { _all: true },
      }),
      this.prisma.delivery.groupBy({
        by: ['currency'],
        where: { customerId, status: DeliveryStatus.DELIVERED },
        _count: { _all: true },
        _sum: { totalAmount: true },
      }),
      this.prisma.delivery.count({
        where: { customerId, status: { not: DeliveryStatus.DRAFT } },
      }),
      this.prisma.delivery.findFirst({
        where: { customerId, status: { not: DeliveryStatus.DRAFT } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
    ]);

    const countOf = (status: DeliveryStatus): number =>
      counts.find((group) => group.status === status)?._count._all ?? 0;

    const active = counts
      .filter((group) => (ACTIVE_DELIVERY_STATUSES as readonly DeliveryStatus[]).includes(group.status))
      .reduce((sum, group) => sum + group._count._all, 0);

    return {
      id: customer.id,
      userId: customer.userId,
      fullName: customer.fullName,
      phone: customer.user.phone,
      avatarUrl: customer.avatarFileId ? (avatars.get(customer.avatarFileId) ?? null) : null,
      status: customer.user.status,
      deliveryCount: bookings,
      lastOrderedAt: latest?.createdAt.toISOString() ?? null,
      joinedAt: customer.createdAt.toISOString(),
      email: customer.user.email,
      suspendedReason: customer.user.suspendedReason,
      lastLoginAt: customer.user.lastLoginAt?.toISOString() ?? null,
      deliveredCount: countOf(DeliveryStatus.DELIVERED),
      cancelledCount: countOf(DeliveryStatus.CANCELLED),
      activeDeliveries: active,
      spend: spend.map((group) => ({
        currency: group.currency,
        totalSpent: group._sum.totalAmount ?? 0,
        deliveredCount: group._count._all,
      })),
      addresses: customer.addresses.map((address) => ({
        id: address.id,
        label: address.label,
        address: address.addressLine,
        latitude: address.latitude,
        longitude: address.longitude,
        isDefault: address.isDefault,
      })),
      favoriteDrivers: customer._count.favoriteDrivers,
    };
  }

  /**
   * Stops a customer signing in or booking.
   *
   * Deliveries already in motion are left alone: the package is on its way,
   * the driver is owed for it, and stopping it would punish everyone except
   * the person being suspended. The detail view reports how many are still
   * running so the operator can follow up.
   */
  async suspend(
    actorUserId: string,
    customerId: string,
    dto: AdminReasonDto,
  ): Promise<AdminCustomerDetailDto> {
    const customer = await this.load(customerId);

    if (customer.user.status === UserStatus.SUSPENDED) {
      throw AppException.conflict(ResponseCode.ACCOUNT_SUSPENDED, 'This customer is already suspended.');
    }

    await this.prisma.user.update({
      where: { id: customer.userId },
      data: { status: UserStatus.SUSPENDED, suspendedReason: dto.reason },
    });

    await this.tokens.revokeAllSessions(customer.userId);
    await this.users.invalidateAuthContext(customer.userId);

    await this.notifications.create({
      userId: customer.userId,
      type: NotificationType.ACCOUNT_STATUS_CHANGED,
      title: 'Your account is suspended',
      body: dto.reason,
    });

    await this.audit.record({
      actorUserId,
      action: 'customer.suspend',
      entityType: 'CustomerProfile',
      entityId: customerId,
      summary: `Suspended ${customer.fullName}: ${dto.reason}`,
      before: { status: customer.user.status },
      after: { status: UserStatus.SUSPENDED, reason: dto.reason },
    });

    return this.findOne(customerId);
  }

  async reinstate(actorUserId: string, customerId: string): Promise<AdminCustomerDetailDto> {
    const customer = await this.load(customerId);

    if (customer.user.status !== UserStatus.SUSPENDED) {
      throw AppException.conflict(ResponseCode.CUSTOMER_NOT_SUSPENDED);
    }

    await this.prisma.user.update({
      where: { id: customer.userId },
      data: { status: UserStatus.ACTIVE, suspendedReason: null },
    });

    await this.users.invalidateAuthContext(customer.userId);

    await this.notifications.create({
      userId: customer.userId,
      type: NotificationType.ACCOUNT_STATUS_CHANGED,
      title: 'Your account is active again',
      body: 'You can sign in and book deliveries.',
    });

    await this.audit.record({
      actorUserId,
      action: 'customer.reinstate',
      entityType: 'CustomerProfile',
      entityId: customerId,
      summary: `Reinstated ${customer.fullName}`,
      before: { status: UserStatus.SUSPENDED },
      after: { status: UserStatus.ACTIVE },
    });

    return this.findOne(customerId);
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async load(customerId: string) {
    const customer = await this.prisma.customerProfile.findUnique({
      where: { id: customerId },
      select: { id: true, userId: true, fullName: true, user: { select: { status: true } } },
    });

    if (!customer) throw AppException.notFound(ResponseCode.CUSTOMER_NOT_FOUND);
    return customer;
  }

  private buildWhere(query: AdminCustomerQueryDto): Prisma.CustomerProfileWhereInput {
    return {
      user: {
        deletedAt: null,
        ...(query.status?.length ? { status: { in: query.status } } : {}),
      },
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
            ],
          }
        : {}),
    };
  }

  private toRow(
    row: Prisma.CustomerProfileGetPayload<{ select: typeof listSelect }>,
    avatars: Map<string, string>,
  ): AdminCustomerRowDto {
    return {
      id: row.id,
      userId: row.userId,
      fullName: row.fullName,
      phone: row.user.phone,
      avatarUrl: row.avatarFileId ? (avatars.get(row.avatarFileId) ?? null) : null,
      status: row.user.status,
      deliveryCount: row._count.deliveries,
      lastOrderedAt: row.deliveries[0]?.createdAt.toISOString() ?? null,
      joinedAt: row.createdAt.toISOString(),
    };
  }

  private endOfDay(date: string): Date {
    const parsed = new Date(date);
    parsed.setUTCHours(23, 59, 59, 999);
    return parsed;
  }
}
