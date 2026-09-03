import { Injectable } from '@nestjs/common';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  DriverApprovalStatus,
  DriverAvailabilityStatus,
  FilePurpose,
  UserRole,
} from '../../generated/prisma/enums.js';
import { FileUrlService } from '../uploads/file-url.service.js';
import { UploadsService } from '../uploads/uploads.service.js';
import { DriverReadinessService } from './driver-readiness.service.js';
import type { DriverProfileDto, UpdateDriverProfileDto } from './dto/driver-profile.dto.js';

@Injectable()
export class DriverProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fileUrls: FileUrlService,
    private readonly uploads: UploadsService,
    private readonly readiness: DriverReadinessService,
  ) {}

  async getProfile(driverId: string): Promise<DriverProfileDto> {
    const driver = await this.prisma.driverProfile.findUnique({
      where: { id: driverId },
      select: {
        id: true,
        userId: true,
        fullName: true,
        avatarFileId: true,
        approvalStatus: true,
        rejectedReason: true,
        suspendedReason: true,
        ratingAverage: true,
        ratingCount: true,
        completedDeliveries: true,
        cancelledDeliveries: true,
        offeredJobs: true,
        acceptedJobs: true,
        createdAt: true,
        user: { select: { phone: true, email: true, status: true } },
        availability: { select: { status: true } },
      },
    });

    if (!driver) {
      throw AppException.notFound(ResponseCode.DRIVER_NOT_FOUND);
    }

    const [avatarUrl, readiness] = await Promise.all([
      this.fileUrls.resolveById(driver.avatarFileId),
      this.readiness.evaluate(driverId),
    ]);

    return {
      id: driver.id,
      userId: driver.userId,
      fullName: driver.fullName,
      phone: driver.user.phone,
      email: driver.user.email,
      avatarUrl,
      approvalStatus: driver.approvalStatus,
      statusReason: this.statusReason(driver.approvalStatus, driver.rejectedReason, driver.suspendedReason),
      availability: driver.availability?.status ?? DriverAvailabilityStatus.OFFLINE,
      accountStatus: driver.user.status,
      stats: {
        ratingAverage: Number(driver.ratingAverage),
        ratingCount: driver.ratingCount,
        completedDeliveries: driver.completedDeliveries,
        cancelledDeliveries: driver.cancelledDeliveries,
        acceptanceRate: driver.offeredJobs > 0 ? Number((driver.acceptedJobs / driver.offeredJobs).toFixed(2)) : 0,
      },
      readiness,
      createdAt: driver.createdAt.toISOString(),
    };
  }

  async updateProfile(driverId: string, userId: string, dto: UpdateDriverProfileDto): Promise<DriverProfileDto> {
    if (dto.email !== undefined && dto.email !== null) {
      const owner = await this.prisma.user.findFirst({
        where: { email: dto.email, role: UserRole.DRIVER, deletedAt: null, NOT: { id: userId } },
        select: { id: true },
      });

      if (owner) {
        throw AppException.conflict(ResponseCode.CONFLICT, 'That email address is already in use.');
      }
    }

    await this.prisma.driverProfile.update({
      where: { id: driverId },
      data: {
        ...(dto.fullName !== undefined ? { fullName: dto.fullName } : {}),
        ...(dto.email !== undefined ? { user: { update: { email: dto.email, emailVerifiedAt: null } } } : {}),
      },
    });

    return this.getProfile(driverId);
  }

  async setAvatar(driverId: string, userId: string, fileId: string): Promise<DriverProfileDto> {
    await this.uploads.assertOwnedForPurpose(fileId, userId, [FilePurpose.DRIVER_AVATAR]);

    const current = await this.prisma.driverProfile.findUniqueOrThrow({
      where: { id: driverId },
      select: { avatarFileId: true },
    });

    await this.prisma.driverProfile.update({ where: { id: driverId }, data: { avatarFileId: fileId } });

    if (current.avatarFileId && current.avatarFileId !== fileId) {
      await this.uploads.discard(current.avatarFileId);
    }

    return this.getProfile(driverId);
  }

  private statusReason(
    status: DriverApprovalStatus,
    rejected: string | null,
    suspended: string | null,
  ): string | null {
    if (status === DriverApprovalStatus.REJECTED) return rejected;
    if (status === DriverApprovalStatus.SUSPENDED) return suspended;
    return null;
  }
}
