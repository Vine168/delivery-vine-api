import { Injectable } from '@nestjs/common';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import { PrismaService } from '../../database/prisma.service.js';
import { DeliveryStatus } from '../../generated/prisma/enums.js';
import { DriverPresenceService } from '../driver-presence/driver-presence.service.js';
import { LocationsService } from '../locations/locations.service.js';
import type { RoutingProfile } from '../locations/providers/map-provider.interface.js';
import { FileUrlService } from '../uploads/file-url.service.js';
import { DeliveryExecutionService } from './delivery-execution.service.js';
import type { DeliveryEtaDto, DeliveryTrackingDto, DriverPositionDto } from './dto/tracking.dto.js';

/** Statuses where the driver is heading to the pickup rather than the drop-off. */
const HEADING_TO_PICKUP: DeliveryStatus[] = [DeliveryStatus.DRIVER_ASSIGNED, DeliveryStatus.ARRIVED_PICKUP];

const HEADING_TO_DROPOFF: DeliveryStatus[] = [
  DeliveryStatus.PICKED_UP,
  DeliveryStatus.IN_TRANSIT,
  DeliveryStatus.ARRIVED_DROPOFF,
];

/**
 * What the customer sees while they wait.
 *
 * The live position comes from Redis, not the database — the driver's app
 * pings every few seconds and none of that is worth persisting. The ETA is a
 * real route, cached by rounded coordinates so repeated polling costs the map
 * provider almost nothing.
 */
@Injectable()
export class DeliveryTrackingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: DriverPresenceService,
    private readonly locations: LocationsService,
    private readonly fileUrls: FileUrlService,
    private readonly execution: DeliveryExecutionService,
  ) {}

  async track(customerId: string, deliveryId: string): Promise<DeliveryTrackingDto> {
    const delivery = await this.prisma.delivery.findFirst({
      where: { id: deliveryId, customerId, deletedAt: null },
      select: {
        id: true,
        bookingCode: true,
        status: true,
        pickupAddress: true,
        pickupLatitude: true,
        pickupLongitude: true,
        pickupPlaceId: true,
        pickupContactName: true,
        pickupContactPhone: true,
        pickupNote: true,
        dropoffAddress: true,
        dropoffLatitude: true,
        dropoffLongitude: true,
        dropoffPlaceId: true,
        dropoffContactName: true,
        dropoffContactPhone: true,
        dropoffNote: true,
        routePolyline: true,
        driverId: true,
        vehicleType: { select: { routingProfile: true } },
        driverVehicle: { select: { plateNumber: true, vehicleType: { select: { name: true } } } },
        driver: {
          select: {
            id: true,
            fullName: true,
            avatarFileId: true,
            ratingAverage: true,
            completedDeliveries: true,
            user: { select: { phone: true } },
          },
        },
        statusHistory: {
          orderBy: { createdAt: 'asc' },
          select: { toStatus: true, actorType: true, reason: true, createdAt: true },
        },
      },
    });

    if (!delivery) {
      throw AppException.notFound(ResponseCode.DELIVERY_NOT_FOUND);
    }

    const [position, avatarUrl, proofOfDelivery] = await Promise.all([
      this.currentPosition(delivery.driverId, delivery.status),
      this.fileUrls.resolveById(delivery.driver?.avatarFileId),
      delivery.status === DeliveryStatus.DELIVERED ? this.execution.findProof(deliveryId) : Promise.resolve(null),
    ]);

    const eta = position
      ? await this.estimateArrival(
          position,
          delivery.status,
          {
            pickup: { latitude: delivery.pickupLatitude, longitude: delivery.pickupLongitude },
            dropoff: { latitude: delivery.dropoffLatitude, longitude: delivery.dropoffLongitude },
          },
          delivery.vehicleType.routingProfile as RoutingProfile,
        )
      : null;

    return {
      deliveryId: delivery.id,
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
      driver: delivery.driver
        ? {
            id: delivery.driver.id,
            fullName: delivery.driver.fullName,
            phone: delivery.driver.user.phone,
            avatarUrl,
            ratingAverage: Number(delivery.driver.ratingAverage),
            completedDeliveries: delivery.driver.completedDeliveries,
            plateNumber: delivery.driverVehicle?.plateNumber ?? null,
            vehicleName: delivery.driverVehicle?.vehicleType.name ?? null,
          }
        : null,
      driverLocation: position,
      eta,
      routePolyline: delivery.routePolyline,
      proofOfDelivery,
      timeline: delivery.statusHistory.map((entry) => ({
        status: entry.toStatus,
        actorType: entry.actorType,
        reason: entry.reason,
        at: entry.createdAt.toISOString(),
      })),
    };
  }

  /** Only shared while the delivery is actually in flight. */
  private async currentPosition(
    driverId: string | null,
    status: DeliveryStatus,
  ): Promise<DriverPositionDto | null> {
    if (!driverId) return null;
    if (![...HEADING_TO_PICKUP, ...HEADING_TO_DROPOFF].includes(status)) return null;

    const fix = await this.presence.getLocation(driverId);
    if (!fix) return null;

    return {
      latitude: fix.latitude,
      longitude: fix.longitude,
      heading: fix.heading,
      speed: fix.speed,
      recordedAt: fix.recordedAt,
    };
  }

  private async estimateArrival(
    position: DriverPositionDto,
    status: DeliveryStatus,
    stops: { pickup: { latitude: number; longitude: number }; dropoff: { latitude: number; longitude: number } },
    profile: RoutingProfile,
  ): Promise<DeliveryEtaDto | null> {
    const heading: 'PICKUP' | 'DROPOFF' = HEADING_TO_PICKUP.includes(status) ? 'PICKUP' : 'DROPOFF';
    const target = heading === 'PICKUP' ? stops.pickup : stops.dropoff;

    // Already standing at the stop — an ETA would be noise.
    if (status === DeliveryStatus.ARRIVED_PICKUP || status === DeliveryStatus.ARRIVED_DROPOFF) {
      return null;
    }

    const route = await this.locations.route(
      [{ latitude: position.latitude, longitude: position.longitude }, target],
      profile,
    );

    return {
      heading,
      seconds: route.durationSeconds,
      distanceMeters: route.distanceMeters,
      arrivingAt: new Date(Date.now() + route.durationSeconds * 1000).toISOString(),
    };
  }
}
