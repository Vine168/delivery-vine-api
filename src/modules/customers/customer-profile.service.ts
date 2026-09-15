import { Injectable } from '@nestjs/common';
import { ACTIVE_DELIVERY_STATUSES, IN_FLIGHT_DELIVERY_STATUSES } from '../../common/constants/delivery-status.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  DeliveryStatus,
  DriverAvailabilityStatus,
  EarningStatus,
  FilePurpose,
  UserRole,
  WithdrawalStatus,
} from '../../generated/prisma/enums.js';
import { FileUrlService } from '../uploads/file-url.service.js';
import { UploadsService } from '../uploads/uploads.service.js';
import { UsersService } from '../users/users.service.js';
import type { CustomerProfileDto, UpdateCustomerProfileDto } from './dto/customer-profile.dto.js';

/** Withdrawals whose money has not finished leaving the wallet. */
const OPEN_WITHDRAWAL_STATUSES = [WithdrawalStatus.PENDING, WithdrawalStatus.APPROVED, WithdrawalStatus.PROCESSING];

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
   *
   * This is the driver account too, so the driver side must be at rest as well:
   * a package in their hands would be stranded with someone who can no longer
   * open the app, and a driver still online would sit in the matching pool
   * until their presence timed out.
   *
   * So must their money. A closed account can never sign in again, so anything
   * still in the wallet, or on its way into or out of it, would be stranded
   * with nobody left to collect it.
   */
  async deleteAccount(customerId: string, userId: string): Promise<void> {
    const [activeDeliveries, driver, fundedWallets] = await Promise.all([
      this.prisma.delivery.count({
        where: { customerId, status: { in: [...ACTIVE_DELIVERY_STATUSES] }, deletedAt: null },
      }),
      this.prisma.driverProfile.findUnique({
        where: { userId },
        select: {
          availability: { select: { status: true } },
          _count: {
            select: {
              deliveries: { where: { status: { in: [...IN_FLIGHT_DELIVERY_STATUSES] } } },
              earnings: { where: { status: EarningStatus.PENDING } },
              withdrawals: { where: { status: { in: OPEN_WITHDRAWAL_STATUSES } } },
            },
          },
        },
      }),
      this.prisma.wallet.count({ where: { userId, balance: { gt: 0 } } }),
    ]);

    if (activeDeliveries > 0 || (driver?._count.deliveries ?? 0) > 0) {
      throw AppException.conflict(
        ResponseCode.ACCOUNT_HAS_ACTIVE_DELIVERIES,
        'Finish or cancel your active deliveries before deleting your account.',
      );
    }

    if (driver?.availability && driver.availability.status !== DriverAvailabilityStatus.OFFLINE) {
      throw AppException.conflict(ResponseCode.CONFLICT, 'Go offline in the driver app before deleting your account.');
    }

    // Before the balance: money reserved for a withdrawal is still in the
    // wallet, and "withdraw it first" would send them to a request that
    // already exists.
    if ((driver?._count.earnings ?? 0) > 0 || (driver?._count.withdrawals ?? 0) > 0) {
      throw AppException.conflict(
        ResponseCode.ACCOUNT_HAS_PENDING_SETTLEMENT,
        'Some of your earnings or a withdrawal are still being processed. Please try again once they have settled.',
      );
    }

    if (fundedWallets > 0) {
      throw AppException.conflict(
        ResponseCode.ACCOUNT_HAS_WALLET_BALANCE,
        'Withdraw your wallet balance before deleting your account.',
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
