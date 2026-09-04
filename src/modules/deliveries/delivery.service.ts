import { Injectable, Logger } from '@nestjs/common';
import { ACTIVE_DELIVERY_STATUSES } from '../../common/constants/delivery-status.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import { PaginationUtil } from '../../common/utils/pagination.util.js';
import type { PaginatedResult } from '../../common/interfaces/paginated.interface.js';
import { PrismaService } from '../../database/prisma.service.js';
import { ActorType, DeliveryStatus, FilePurpose, PaymentMethod, PaymentStatus } from '../../generated/prisma/enums.js';
import { UploadsService } from '../uploads/uploads.service.js';
import { PromoCodesService } from '../promo-codes/promo-codes.service.js';
import { BookingCodeService } from './booking-code.service.js';
import { DeliveryQuoteService, type PricedDelivery } from './delivery-quote.service.js';
import { DeliveryStateService } from './delivery-state.service.js';
import { DeliveryMapper } from './delivery.mapper.js';
import { deliveryDetailSelect, deliveryListSelect, type DeliveryDetail } from './delivery.select.js';
import type {
  CancelDeliveryDto,
  CreateDeliveryDto,
  DeliveryPackageDto,
} from './dto/delivery-request.dto.js';
import type {
  DeliveryDto,
  DeliveryPackageViewDto,
  DeliverySummaryDto,
  ListDeliveriesQueryDto,
} from './dto/delivery-response.dto.js';

const MAX_ACTIVE_DELIVERIES_PER_CUSTOMER = 5;

@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly quotes: DeliveryQuoteService,
    private readonly state: DeliveryStateService,
    private readonly bookingCodes: BookingCodeService,
    private readonly promos: PromoCodesService,
    private readonly uploads: UploadsService,
    private readonly mapper: DeliveryMapper,
  ) {}

  /**
   * Creates and confirms a booking.
   *
   * The price is recalculated here from the pickup, drop-off and vehicle type —
   * whatever the app was showing is irrelevant. Everything else (packages,
   * recipient, promo usage, the DRAFT → SEARCHING_DRIVER transition and its
   * history row) happens in one transaction, so a booking is never half made.
   */
  async create(customerId: string, userId: string, dto: CreateDeliveryDto): Promise<DeliveryDto> {
    await this.assertNotTooManyActive(customerId);
    await this.assertPackagePhotosOwned(dto.packages, userId);

    const priced = await this.quotes.price(dto, customerId);
    const bookingCode = await this.bookingCodes.next();
    const cod = dto.cod?.enabled === true;

    const confirmed = await this.prisma.$transaction(async (tx) => {
      const delivery = await tx.delivery.create({
        data: {
          bookingCode,
          customerId,
          vehicleTypeId: priced.vehicleType.id,
          status: DeliveryStatus.DRAFT,

          pickupAddress: dto.pickup.address,
          pickupLatitude: dto.pickup.latitude,
          pickupLongitude: dto.pickup.longitude,
          pickupPlaceId: dto.pickup.placeId,
          pickupContactName: dto.pickup.contactName,
          pickupContactPhone: dto.pickup.contactPhone,
          pickupNote: dto.pickup.note,

          dropoffAddress: dto.dropoff.address,
          dropoffLatitude: dto.dropoff.latitude,
          dropoffLongitude: dto.dropoff.longitude,
          dropoffPlaceId: dto.dropoff.placeId,
          dropoffContactName: dto.dropoff.contactName,
          dropoffContactPhone: dto.dropoff.contactPhone,
          dropoffNote: dto.dropoff.note,

          distanceMeters: priced.route.distanceMeters,
          durationSeconds: priced.route.durationSeconds,
          routePolyline: priced.route.polyline,
          routeProvider: priced.route.source,

          currency: priced.price.currency,
          baseFare: priced.price.baseFare,
          distanceFare: priced.price.distanceFare,
          timeFare: priced.price.timeFare,
          waitingFee: priced.price.waitingFee,
          surgeAmount: priced.price.surgeAmount,
          serviceFee: priced.price.serviceFee,
          codFee: priced.price.codFee,
          subtotalAmount: priced.price.subtotal,
          discountAmount: priced.price.discountAmount,
          totalAmount: priced.price.totalAmount,
          commissionPercentBp: priced.price.commissionPercentBp,
          commissionAmount: priced.price.commissionAmount,
          driverEarningAmount: priced.price.driverEarningAmount,
          pricingRuleId: priced.rule.id,
          pricingSnapshot: this.snapshotFor(priced),
          promoCodeId: priced.promo?.promoCodeId,

          paymentMethod: dto.paymentMethod,
          paymentStatus:
            dto.paymentMethod === PaymentMethod.CASH_ON_DELIVERY ? PaymentStatus.PENDING : PaymentStatus.PENDING,
          codEnabled: cod,
          codAmount: cod ? dto.cod?.amount : null,
          codCurrency: cod ? priced.price.currency : null,
          codPayer: cod ? (dto.cod?.payer ?? 'RECIPIENT') : null,

          customerNote: dto.note,

          packages: {
            create: dto.packages.map((item) => ({
              size: item.size,
              quantity: item.quantity ?? 1,
              weightKg: item.weightKg,
              category: item.category,
              description: item.description,
              remarks: item.remarks,
              declaredValueAmount: item.declaredValue?.amount,
              declaredValueCurrency: item.declaredValue?.currency,
              photoFileId: item.photoFileId,
            })),
          },

          recipient: dto.recipient
            ? {
                create: {
                  name: dto.recipient.name,
                  phone: dto.recipient.phone,
                  alternatePhone: dto.recipient.alternatePhone,
                  note: dto.recipient.note,
                },
              }
            : {
                // The drop-off contact is the recipient unless told otherwise.
                create: {
                  name: dto.dropoff.contactName,
                  phone: dto.dropoff.contactPhone,
                  note: dto.dropoff.note,
                },
              },
        },
        select: { id: true },
      });

      if (priced.promo) {
        await this.promos.recordUsage(tx, {
          promoCodeId: priced.promo.promoCodeId,
          customerId,
          deliveryId: delivery.id,
          discountAmount: priced.promo.discountAmount,
          currency: priced.promo.currency,
        });
      }

      // Confirming is a real transition, so it is audited like every other one.
      return this.state.transition(tx, {
        deliveryId: delivery.id,
        to: DeliveryStatus.SEARCHING_DRIVER,
        actorType: ActorType.CUSTOMER,
        actorUserId: userId,
        data: { searchStartedAt: new Date() },
      });
    });

    await this.state.publish(confirmed);

    return this.findOne(customerId, confirmed.deliveryId);
  }

  async findAll(customerId: string, query: ListDeliveriesQueryDto): Promise<PaginatedResult<DeliverySummaryDto>> {
    const where = {
      customerId,
      deletedAt: null,
      ...(query.status?.length ? { status: { in: query.status } } : {}),
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
              { bookingCode: { contains: query.search, mode: 'insensitive' as const } },
              { pickupAddress: { contains: query.search, mode: 'insensitive' as const } },
              { dropoffAddress: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.delivery.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
        select: deliveryListSelect,
      }),
      this.prisma.delivery.count({ where }),
    ]);

    return PaginationUtil.paginate(rows.map((row) => this.mapper.toSummary(row)), query.page, query.limit, total);
  }

  async findOne(customerId: string, deliveryId: string): Promise<DeliveryDto> {
    return this.mapper.toDetail(await this.findOwnedOrThrow(customerId, deliveryId));
  }

  async findPackages(customerId: string, deliveryId: string): Promise<DeliveryPackageViewDto[]> {
    const delivery = await this.findOwnedOrThrow(customerId, deliveryId);
    return this.mapper.toPackages(delivery.packages);
  }

  async cancel(customerId: string, userId: string, deliveryId: string, dto: CancelDeliveryDto): Promise<DeliveryDto> {
    const delivery = await this.findOwnedOrThrow(customerId, deliveryId);

    if (delivery.status === DeliveryStatus.CANCELLED) {
      throw AppException.conflict(ResponseCode.DELIVERY_ALREADY_CANCELLED, 'This delivery is already cancelled.');
    }
    if (delivery.status === DeliveryStatus.DELIVERED) {
      throw AppException.conflict(ResponseCode.DELIVERY_ALREADY_COMPLETED, 'This delivery has already been completed.');
    }

    const result = await this.prisma.$transaction((tx) =>
      this.state.transition(tx, {
        deliveryId,
        to: DeliveryStatus.CANCELLED,
        actorType: ActorType.CUSTOMER,
        actorUserId: userId,
        reason: dto.reason,
        data: {
          cancelledByType: ActorType.CUSTOMER,
          cancelledByUserId: userId,
          cancelReason: dto.reason,
        },
      }),
    );

    await this.state.publish(result);
    return this.findOne(customerId, deliveryId);
  }

  /**
   * Books the same route again. Prices are recalculated from today's rules —
   * a rebook is a new booking, not a copy of an old receipt.
   */
  async rebook(customerId: string, userId: string, deliveryId: string): Promise<DeliveryDto> {
    const previous = await this.findOwnedOrThrow(customerId, deliveryId);

    const dto: CreateDeliveryDto = {
      pickup: {
        address: previous.pickupAddress,
        latitude: previous.pickupLatitude,
        longitude: previous.pickupLongitude,
        placeId: previous.pickupPlaceId ?? undefined,
        contactName: previous.pickupContactName,
        contactPhone: previous.pickupContactPhone,
        note: previous.pickupNote ?? undefined,
      },
      dropoff: {
        address: previous.dropoffAddress,
        latitude: previous.dropoffLatitude,
        longitude: previous.dropoffLongitude,
        placeId: previous.dropoffPlaceId ?? undefined,
        contactName: previous.dropoffContactName,
        contactPhone: previous.dropoffContactPhone,
        note: previous.dropoffNote ?? undefined,
      },
      vehicleTypeId: await this.vehicleTypeIdFor(deliveryId),
      currency: previous.currency,
      packages: previous.packages.map((item) => ({
        size: item.size,
        quantity: item.quantity,
        weightKg: item.weightKg ?? undefined,
        category: item.category ?? undefined,
        description: item.description ?? undefined,
        remarks: item.remarks ?? undefined,
        declaredValue:
          item.declaredValueAmount !== null && item.declaredValueCurrency !== null
            ? { amount: item.declaredValueAmount, currency: item.declaredValueCurrency }
            : undefined,
        // Photos are not carried over: a new delivery gets new photos.
      })),
      paymentMethod: previous.paymentMethod,
      note: previous.customerNote ?? undefined,
      ...(previous.codEnabled && previous.codAmount
        ? { cod: { enabled: true, amount: previous.codAmount, payer: previous.codPayer ?? undefined } }
        : {}),
    };

    return this.create(customerId, userId, dto);
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async findOwnedOrThrow(customerId: string, deliveryId: string): Promise<DeliveryDetail> {
    const delivery = await this.prisma.delivery.findFirst({
      where: { id: deliveryId, customerId, deletedAt: null },
      select: deliveryDetailSelect,
    });

    if (!delivery) {
      // Same answer whether it does not exist or belongs to someone else.
      throw AppException.notFound(ResponseCode.DELIVERY_NOT_FOUND);
    }

    return delivery;
  }

  private async vehicleTypeIdFor(deliveryId: string): Promise<string> {
    const { vehicleTypeId } = await this.prisma.delivery.findUniqueOrThrow({
      where: { id: deliveryId },
      select: { vehicleTypeId: true },
    });
    return vehicleTypeId;
  }

  private async assertNotTooManyActive(customerId: string): Promise<void> {
    const active = await this.prisma.delivery.count({
      where: { customerId, status: { in: [...ACTIVE_DELIVERY_STATUSES] }, deletedAt: null },
    });

    if (active >= MAX_ACTIVE_DELIVERIES_PER_CUSTOMER) {
      throw AppException.unprocessable(
        ResponseCode.CONFLICT,
        `You can have up to ${MAX_ACTIVE_DELIVERIES_PER_CUSTOMER} deliveries in progress at once.`,
      );
    }
  }

  /** A package photo must belong to the customer booking the delivery. */
  private async assertPackagePhotosOwned(packages: DeliveryPackageDto[], userId: string): Promise<void> {
    const photoIds = packages.map((item) => item.photoFileId).filter((id): id is string => Boolean(id));

    await Promise.all(
      photoIds.map((id) => this.uploads.assertOwnedForPurpose(id, userId, [FilePurpose.PACKAGE_PHOTO])),
    );
  }

  private snapshotFor(priced: PricedDelivery) {
    return {
      ...(priced.route.source === 'haversine' ? { routeEstimated: true } : {}),
      ...JSON.parse(
        JSON.stringify(
          // Prisma wants plain JSON, and the snapshot must survive a schema change.
          {
            pricingRuleId: priced.rule.id,
            pricingRuleName: priced.rule.name,
            pricingRuleVersion: priced.rule.version,
            calculatedAt: new Date().toISOString(),
            route: {
              distanceMeters: priced.route.distanceMeters,
              durationSeconds: priced.route.durationSeconds,
              source: priced.route.source,
            },
            breakdown: priced.price,
          },
        ),
      ),
    };
  }

  private endOfDay(date: string): Date {
    const parsed = new Date(date);
    parsed.setUTCHours(23, 59, 59, 999);
    return parsed;
  }
}
