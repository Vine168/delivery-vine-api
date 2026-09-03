import { Injectable } from '@nestjs/common';
import { ACTIVE_DELIVERY_STATUSES } from '../../common/constants/delivery-status.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import { PrismaService } from '../../database/prisma.service.js';
import { DeliveryStatus, FilePurpose, UserRole } from '../../generated/prisma/enums.js';
import { FileUrlService } from '../uploads/file-url.service.js';
import { UploadsService } from '../uploads/uploads.service.js';
import { UsersService } from '../users/users.service.js';
import type { CustomerProfileDto, UpdateCustomerProfileDto } from './dto/customer-profile.dto.js';

@Injectable()
export class CustomerProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fileUrls: FileUrlService,
    private readonly uploads: UploadsService,
    private readonly users: UsersService,
  ) {}

  async getProfile(customerId: string): Promise<CustomerProfileDto> {
    const profile = await this.prisma.customerProfile.findUnique({
      where: { id: customerId },
      select: {
        id: true,
        userId: true,
        fullName: true,
        avatarFileId: true,
        dateOfBirth: true,
        createdAt: true,
        user: { select: { phone: true, email: true, status: true, phoneVerifiedAt: true } },
      },
    });

    if (!profile) {
      throw AppException.notFound(ResponseCode.ACCOUNT_NOT_FOUND);
    }

    const [statusCounts, savedAddresses, avatarUrl] = await Promise.all([
      this.prisma.delivery.groupBy({
        by: ['status'],
        where: { customerId, deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.customerAddress.count({ where: { customerId, deletedAt: null } }),
      this.fileUrls.resolveById(profile.avatarFileId),
    ]);

    const countFor = (statuses: readonly DeliveryStatus[]): number =>
      statusCounts
        .filter((row) => statuses.includes(row.status))
        .reduce((total, row) => total + row._count._all, 0);

    return {
      id: profile.id,
      userId: profile.userId,
      fullName: profile.fullName,
      phone: profile.user.phone,
      email: profile.user.email,
      avatarUrl,
      dateOfBirth: profile.dateOfBirth ? profile.dateOfBirth.toISOString().slice(0, 10) : null,
      status: profile.user.status,
      phoneVerified: profile.user.phoneVerifiedAt !== null,
      stats: {
        totalDeliveries: statusCounts.reduce((total, row) => total + row._count._all, 0),
        completedDeliveries: countFor([DeliveryStatus.DELIVERED]),
        activeDeliveries: countFor(ACTIVE_DELIVERY_STATUSES),
        savedAddresses,
      },
      createdAt: profile.createdAt.toISOString(),
    };
  }

  async updateProfile(customerId: string, userId: string, dto: UpdateCustomerProfileDto): Promise<CustomerProfileDto> {
    if (dto.email !== undefined && dto.email !== null) {
      await this.assertEmailAvailable(dto.email, userId);
    }

    await this.prisma.customerProfile.update({
      where: { id: customerId },
      data: {
        ...(dto.fullName !== undefined ? { fullName: dto.fullName } : {}),
        ...(dto.dateOfBirth !== undefined ? { dateOfBirth: new Date(dto.dateOfBirth) } : {}),
        ...(dto.email !== undefined
          ? { user: { update: { email: dto.email, emailVerifiedAt: null } } }
          : {}),
      },
    });

    return this.getProfile(customerId);
  }

  /** Swaps the avatar and removes the previous file — storage does not accumulate orphans. */
  async setAvatar(customerId: string, userId: string, fileId: string): Promise<CustomerProfileDto> {
    await this.uploads.assertOwnedForPurpose(fileId, userId, [FilePurpose.CUSTOMER_AVATAR]);

    const current = await this.prisma.customerProfile.findUniqueOrThrow({
      where: { id: customerId },
      select: { avatarFileId: true },
    });

    await this.prisma.customerProfile.update({
      where: { id: customerId },
      data: { avatarFileId: fileId },
    });

    if (current.avatarFileId && current.avatarFileId !== fileId) {
      await this.uploads.discard(current.avatarFileId);
    }

    return this.getProfile(customerId);
  }

  /**
   * Soft deletion. Deliveries and payments are financial records and are kept;
   * the account is closed and the phone number freed for re-registration.
   */
  async deleteAccount(customerId: string, userId: string): Promise<void> {
    const activeDeliveries = await this.prisma.delivery.count({
      where: { customerId, status: { in: [...ACTIVE_DELIVERY_STATUSES] }, deletedAt: null },
    });

    if (activeDeliveries > 0) {
      throw AppException.conflict(
        ResponseCode.ACCOUNT_HAS_ACTIVE_DELIVERIES,
        'Finish or cancel your active deliveries before deleting your account.',
      );
    }

    await this.users.softDelete(userId);
  }

  /** Scoped to the role, matching the `@@unique([email, role])` constraint. */
  private async assertEmailAvailable(email: string, userId: string): Promise<void> {
    const owner = await this.prisma.user.findFirst({
      where: { email, role: UserRole.CUSTOMER, deletedAt: null, NOT: { id: userId } },
      select: { id: true },
    });

    if (owner) {
      throw AppException.conflict(ResponseCode.CONFLICT, 'That email address is already in use.');
    }
  }
}
