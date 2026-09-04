import { Injectable } from '@nestjs/common';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import { PrismaService } from '../../database/prisma.service.js';
import { isPrismaKnownError } from '../../database/prisma-exception.util.js';
import { DeliveryStatus, DriverApprovalStatus } from '../../generated/prisma/enums.js';
import { DriverPresenceService } from '../driver-presence/driver-presence.service.js';
import { FileUrlService } from '../uploads/file-url.service.js';
import type { FavoriteDriverDto } from './dto/favorite-driver.dto.js';

/**
 * Drivers a customer has chosen to keep.
 *
 * The matching service reads this list and offers a delivery to a favourite
 * first, which is the whole point of the feature.
 */
@Injectable()
export class FavoriteDriversService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: DriverPresenceService,
    private readonly fileUrls: FileUrlService,
  ) {}

  async findAll(customerId: string): Promise<FavoriteDriverDto[]> {
    const favourites = await this.prisma.favoriteDriver.findMany({
      where: { customerId, driver: { deletedAt: null } },
      orderBy: { createdAt: 'desc' },
      select: {
        createdAt: true,
        driver: {
          select: {
            id: true,
            fullName: true,
            avatarFileId: true,
            ratingAverage: true,
            ratingCount: true,
            completedDeliveries: true,
            vehicles: {
              where: { isPrimary: true, deletedAt: null },
              select: { vehicleType: { select: { code: true } } },
              take: 1,
            },
          },
        },
      },
    });

    if (favourites.length === 0) return [];

    const driverIds = favourites.map((row) => row.driver.id);

    const [avatarUrls, onlineFlags, togetherCounts] = await Promise.all([
      this.fileUrls.resolveMany(favourites.map((row) => row.driver.avatarFileId)),
      Promise.all(driverIds.map((id) => this.presence.isOnline(id))),
      this.prisma.delivery.groupBy({
        by: ['driverId'],
        where: { customerId, driverId: { in: driverIds }, status: DeliveryStatus.DELIVERED },
        _count: { _all: true },
      }),
    ]);

    const together = new Map(togetherCounts.map((row) => [row.driverId, row._count._all]));

    return favourites.map((row, index) => ({
      driverId: row.driver.id,
      fullName: row.driver.fullName,
      avatarUrl: row.driver.avatarFileId ? (avatarUrls.get(row.driver.avatarFileId) ?? null) : null,
      ratingAverage: Number(row.driver.ratingAverage),
      ratingCount: row.driver.ratingCount,
      completedDeliveries: row.driver.completedDeliveries,
      vehicleTypeCode: row.driver.vehicles[0]?.vehicleType.code ?? null,
      isOnline: onlineFlags[index],
      deliveriesTogether: together.get(row.driver.id) ?? 0,
      favouritedAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * Saving a driver requires having actually been delivered to by them —
   * otherwise the list is a way to probe for drivers rather than to remember
   * one.
   */
  async add(customerId: string, driverId: string): Promise<void> {
    const driver = await this.prisma.driverProfile.findFirst({
      where: { id: driverId, deletedAt: null, approvalStatus: DriverApprovalStatus.ACTIVE },
      select: { id: true },
    });

    if (!driver) {
      throw AppException.notFound(ResponseCode.DRIVER_NOT_FOUND);
    }

    const delivered = await this.prisma.delivery.count({
      where: { customerId, driverId, status: DeliveryStatus.DELIVERED },
    });

    if (delivered === 0) {
      throw AppException.unprocessable(
        ResponseCode.RATING_NOT_ALLOWED,
        'You can save a driver once they have completed a delivery for you.',
      );
    }

    try {
      await this.prisma.favoriteDriver.create({ data: { customerId, driverId } });
    } catch (error) {
      if (isPrismaKnownError(error) && error.code === 'P2002') {
        throw AppException.conflict(ResponseCode.FAVORITE_DRIVER_ALREADY_ADDED, 'This driver is already saved.');
      }
      throw error;
    }
  }

  async remove(customerId: string, driverId: string): Promise<void> {
    const { count } = await this.prisma.favoriteDriver.deleteMany({ where: { customerId, driverId } });

    if (count === 0) {
      throw AppException.notFound(ResponseCode.DRIVER_NOT_FOUND, 'That driver is not in your saved list.');
    }
  }
}
