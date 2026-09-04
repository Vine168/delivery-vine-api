import { Injectable, Logger } from '@nestjs/common';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import { PrismaService } from '../../database/prisma.service.js';
import { DeliveryStatus } from '../../generated/prisma/enums.js';
import type { CreateRatingDto, RatingDto } from './dto/rating.dto.js';

/** How long after delivery a customer may still leave a rating. */
const RATING_WINDOW_DAYS = 14;

@Injectable()
export class RatingsService {
  private readonly logger = new Logger(RatingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Rates a completed delivery.
   *
   * Only the customer who booked it, only once, only after it was delivered,
   * and only while it is recent enough to remember. The driver's aggregate is
   * recomputed from the ratings table inside the same transaction rather than
   * nudged by a running average, so it cannot drift and a replay cannot
   * inflate it.
   */
  async create(customerId: string, deliveryId: string, dto: CreateRatingDto): Promise<RatingDto> {
    const delivery = await this.prisma.delivery.findFirst({
      where: { id: deliveryId, customerId, deletedAt: null },
      select: {
        id: true,
        status: true,
        driverId: true,
        deliveredAt: true,
        rating: { select: { id: true } },
        driver: { select: { fullName: true } },
      },
    });

    if (!delivery) {
      throw AppException.notFound(ResponseCode.DELIVERY_NOT_FOUND);
    }

    if (delivery.status !== DeliveryStatus.DELIVERED) {
      throw AppException.unprocessable(
        ResponseCode.RATING_NOT_ALLOWED,
        'You can rate a delivery once it has been completed.',
      );
    }

    if (!delivery.driverId) {
      throw AppException.unprocessable(ResponseCode.RATING_NOT_ALLOWED, 'This delivery had no driver.');
    }

    if (delivery.rating) {
      throw AppException.conflict(ResponseCode.RATING_ALREADY_SUBMITTED, 'You have already rated this delivery.');
    }

    const deadline = new Date((delivery.deliveredAt ?? new Date()).getTime() + RATING_WINDOW_DAYS * 86_400_000);
    if (Date.now() > deadline.getTime()) {
      throw AppException.unprocessable(
        ResponseCode.RATING_NOT_ALLOWED,
        `Deliveries can be rated for up to ${RATING_WINDOW_DAYS} days.`,
      );
    }

    const driverId = delivery.driverId;

    const rating = await this.prisma.$transaction(async (tx) => {
      const created = await tx.deliveryRating.create({
        data: {
          deliveryId,
          customerId,
          driverId,
          rating: dto.rating,
          comment: dto.comment,
          tags: dto.tags ?? [],
        },
        select: ratingSelect,
      });

      // Recomputed, not incremented: exact, and safe to run twice.
      await tx.$executeRaw`
        UPDATE "DriverProfile" AS d
        SET "ratingAverage" = source.average, "ratingCount" = source.total
        FROM (
          SELECT COALESCE(AVG(rating), 0)::numeric(3,2) AS average, COUNT(*)::int AS total
          FROM "DeliveryRating"
          WHERE "driverId" = ${driverId}
        ) AS source
        WHERE d.id = ${driverId}
      `;

      return created;
    });

    return this.toDto(rating, delivery.driver?.fullName ?? '');
  }

  async findOne(customerId: string, deliveryId: string): Promise<RatingDto> {
    const rating = await this.prisma.deliveryRating.findFirst({
      where: { deliveryId, customerId },
      select: { ...ratingSelect, driver: { select: { fullName: true } } },
    });

    if (!rating) {
      throw AppException.notFound(ResponseCode.RATING_NOT_FOUND, 'This delivery has not been rated yet.');
    }

    return this.toDto(rating, rating.driver.fullName);
  }

  private toDto(
    rating: { id: string; deliveryId: string; rating: number; comment: string | null; tags: string[]; createdAt: Date },
    driverName: string,
  ): RatingDto {
    return {
      id: rating.id,
      deliveryId: rating.deliveryId,
      rating: rating.rating,
      comment: rating.comment,
      tags: rating.tags,
      driverName,
      createdAt: rating.createdAt.toISOString(),
    };
  }
}

const ratingSelect = {
  id: true,
  deliveryId: true,
  rating: true,
  comment: true,
  tags: true,
  createdAt: true,
} as const;
