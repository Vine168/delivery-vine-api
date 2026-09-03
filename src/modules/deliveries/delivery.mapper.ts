import { Injectable } from '@nestjs/common';
import { cancellableBy } from './delivery-state.policy.js';
import { ActorType, DeliveryStatus } from '../../generated/prisma/enums.js';
import { FileUrlService } from '../uploads/file-url.service.js';
import type { PriceBreakdownDto } from '../pricing/dto/price-breakdown.dto.js';
import type {
  DeliveryDto,
  DeliveryPackageViewDto,
  DeliverySummaryDto,
} from './dto/delivery-response.dto.js';
import type { DeliveryDetail, DeliveryListRow } from './delivery.select.js';

const CUSTOMER_CANCELLABLE = new Set<DeliveryStatus>(cancellableBy(ActorType.CUSTOMER));

/**
 * Database rows to API shapes.
 *
 * Kept out of the services so that what the customer sees is defined in one
 * place — including what they must *not* see, such as the driver's internal
 * ids or the commission split.
 */
@Injectable()
export class DeliveryMapper {
  constructor(private readonly fileUrls: FileUrlService) {}

  async toDetail(delivery: DeliveryDetail): Promise<DeliveryDto> {
    const photoIds = delivery.packages.map((item) => item.photoFileId);
    const [photoUrls, driverAvatarUrl] = await Promise.all([
      this.fileUrls.resolveMany(photoIds),
      this.fileUrls.resolveById(delivery.driver?.avatarFileId),
    ]);

    return {
      id: delivery.id,
      bookingCode: delivery.bookingCode,
      status: delivery.status,
      pickup: {
        address: delivery.pickupAddress,
        latitude: delivery.pickupLatitude,
        longitude: delivery.pickupLongitude,
        contactName: delivery.pickupContactName,
        contactPhone: delivery.pickupContactPhone,
        note: delivery.pickupNote,
        placeId: delivery.pickupPlaceId,
      },
      dropoff: {
        address: delivery.dropoffAddress,
        latitude: delivery.dropoffLatitude,
        longitude: delivery.dropoffLongitude,
        contactName: delivery.dropoffContactName,
        contactPhone: delivery.dropoffContactPhone,
        note: delivery.dropoffNote,
        placeId: delivery.dropoffPlaceId,
      },
      vehicleTypeCode: delivery.vehicleType.code,
      vehicleTypeName: delivery.vehicleType.name,
      distanceMeters: delivery.distanceMeters,
      durationSeconds: delivery.durationSeconds,
      routePolyline: delivery.routePolyline,
      price: this.toPriceBreakdown(delivery),
      paymentMethod: delivery.paymentMethod,
      paymentStatus: delivery.paymentStatus,
      codEnabled: delivery.codEnabled,
      codAmount: delivery.codAmount,
      codPayer: delivery.codPayer,
      packages: delivery.packages.map((item) => this.toPackage(item, photoUrls)),
      driver: delivery.driver
        ? {
            id: delivery.driver.id,
            fullName: delivery.driver.fullName,
            phone: delivery.driver.user.phone,
            avatarUrl: driverAvatarUrl,
            ratingAverage: Number(delivery.driver.ratingAverage),
            completedDeliveries: delivery.driver.completedDeliveries,
            plateNumber: delivery.driverVehicle?.plateNumber ?? null,
            vehicleName: delivery.driverVehicle?.vehicleType.name ?? null,
          }
        : null,
      note: delivery.customerNote,
      cancelledByType: delivery.cancelledByType,
      cancelReason: delivery.cancelReason,
      canCancel: CUSTOMER_CANCELLABLE.has(delivery.status),
      canRate: delivery.status === DeliveryStatus.DELIVERED && delivery.rating === null,
      timeline: delivery.statusHistory.map((entry) => ({
        status: entry.toStatus,
        actorType: entry.actorType,
        reason: entry.reason,
        at: entry.createdAt.toISOString(),
      })),
      createdAt: delivery.createdAt.toISOString(),
      confirmedAt: delivery.confirmedAt?.toISOString() ?? null,
      assignedAt: delivery.assignedAt?.toISOString() ?? null,
      pickedUpAt: delivery.pickedUpAt?.toISOString() ?? null,
      deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
      cancelledAt: delivery.cancelledAt?.toISOString() ?? null,
    };
  }

  toSummary(delivery: DeliveryListRow): DeliverySummaryDto {
    return {
      id: delivery.id,
      bookingCode: delivery.bookingCode,
      status: delivery.status,
      pickupAddress: delivery.pickupAddress,
      dropoffAddress: delivery.dropoffAddress,
      vehicleTypeCode: delivery.vehicleType.code,
      totalAmount: delivery.totalAmount,
      currency: delivery.currency,
      paymentMethod: delivery.paymentMethod,
      paymentStatus: delivery.paymentStatus,
      distanceMeters: delivery.distanceMeters,
      driverName: delivery.driver?.fullName ?? null,
      createdAt: delivery.createdAt.toISOString(),
      deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
    };
  }

  async toPackages(
    packages: DeliveryDetail['packages'],
  ): Promise<DeliveryPackageViewDto[]> {
    const photoUrls = await this.fileUrls.resolveMany(packages.map((item) => item.photoFileId));
    return packages.map((item) => this.toPackage(item, photoUrls));
  }

  private toPackage(item: DeliveryDetail['packages'][number], photoUrls: Map<string, string>): DeliveryPackageViewDto {
    return {
      id: item.id,
      size: item.size,
      quantity: item.quantity,
      weightKg: item.weightKg,
      category: item.category,
      description: item.description,
      remarks: item.remarks,
      declaredValueAmount: item.declaredValueAmount,
      declaredValueCurrency: item.declaredValueCurrency,
      photoUrl: item.photoFileId ? (photoUrls.get(item.photoFileId) ?? null) : null,
    };
  }

  /**
   * Rebuilds the customer-facing breakdown from the stored columns.
   *
   * Commission and driver earning are deliberately omitted: what the platform
   * keeps is not the customer's business.
   */
  private toPriceBreakdown(delivery: DeliveryDetail): PriceBreakdownDto {
    const snapshot = delivery.pricingSnapshot as { breakdown?: PriceBreakdownDto } | null;
    const lines = snapshot?.breakdown?.lines ?? [];

    return {
      currency: delivery.currency,
      baseFare: delivery.baseFare,
      distanceFare: delivery.distanceFare,
      timeFare: delivery.timeFare,
      waitingFee: delivery.waitingFee,
      surgeAmount: delivery.surgeAmount,
      serviceFee: delivery.serviceFee,
      codFee: delivery.codFee,
      fareSubtotal: delivery.subtotalAmount - delivery.serviceFee - delivery.codFee,
      subtotal: delivery.subtotalAmount,
      discountAmount: delivery.discountAmount,
      totalAmount: delivery.totalAmount,
      commissionPercentBp: 0,
      commissionAmount: 0,
      driverEarningAmount: 0,
      minimumFareApplied: snapshot?.breakdown?.minimumFareApplied ?? false,
      promoCode: snapshot?.breakdown?.promoCode ?? null,
      lines,
    };
  }
}
