import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEvent, WsEvent } from '../common/constants/events.js';
import { PrismaService } from '../database/prisma.service.js';
import { DeliveryStatus } from '../generated/prisma/enums.js';
import type { TransitionResult } from '../modules/deliveries/delivery-state.service.js';
import type { OfferedJob } from '../modules/delivery-matching/delivery-matching.service.js';
import { RealtimeEmitter } from './realtime.emitter.js';

interface OfferLapsed {
  deliveryId: string;
  round?: number;
  exceptDriverId?: string;
  driverIds: string[];
}

interface LocationReported {
  driverId: string;
  deliveryId: string;
  latitude: number;
  longitude: number;
}

/** Status changes worth their own named event, so clients need not switch on strings. */
const STATUS_EVENTS: Partial<Record<DeliveryStatus, string>> = {
  [DeliveryStatus.DRIVER_ASSIGNED]: WsEvent.DELIVERY_DRIVER_ASSIGNED,
  [DeliveryStatus.ARRIVED_PICKUP]: WsEvent.DELIVERY_ARRIVED_PICKUP,
  [DeliveryStatus.PICKED_UP]: WsEvent.DELIVERY_PICKED_UP,
  [DeliveryStatus.ARRIVED_DROPOFF]: WsEvent.DELIVERY_ARRIVED_DROPOFF,
  [DeliveryStatus.DELIVERED]: WsEvent.DELIVERY_COMPLETED,
  [DeliveryStatus.CANCELLED]: WsEvent.DELIVERY_CANCELLED,
};

/**
 * The bridge from domain events to sockets.
 *
 * Business services announce what happened and know nothing about
 * WebSockets; this listener is the only thing that translates those
 * announcements into pushes. Adding a new realtime event never means editing a
 * service.
 */
@Injectable()
export class RealtimeListener {
  private readonly logger = new Logger(RealtimeListener.name);

  constructor(
    private readonly emitter: RealtimeEmitter,
    private readonly prisma: PrismaService,
  ) {}

  @OnEvent(DomainEvent.DELIVERY_STATUS_CHANGED)
  async onStatusChanged(event: TransitionResult): Promise<void> {
    const payload = {
      deliveryId: event.deliveryId,
      bookingCode: event.bookingCode,
      status: event.to,
      previousStatus: event.from,
      driverId: event.driverId,
      at: new Date().toISOString(),
    };

    const customerUserId = await this.customerUserId(event.customerId);

    // Always the generic event, so a client can watch one channel…
    this.emitter.toDeliveryParticipants(
      event.deliveryId,
      customerUserId,
      WsEvent.DELIVERY_STATUS_UPDATED,
      payload,
    );

    // …plus a specific one for the milestones a UI reacts to differently.
    const specific = STATUS_EVENTS[event.to];
    if (specific) {
      this.emitter.toDeliveryParticipants(event.deliveryId, customerUserId, specific, payload);
    }

    if (event.driverId) {
      this.emitter.toDriver(event.driverId, WsEvent.DELIVERY_STATUS_UPDATED, payload);
    }
  }

  @OnEvent(WsEvent.DRIVER_REQUEST_RECEIVED)
  onOffer(offer: OfferedJob): void {
    this.emitter.toDriver(offer.driverId, WsEvent.DRIVER_REQUEST_RECEIVED, {
      deliveryId: offer.deliveryId,
      assignmentId: offer.assignmentId,
      estimatedEarningAmount: offer.estimatedEarningAmount,
      distanceToPickupMeters: offer.distanceToPickupMeters,
      expiresAt: offer.expiresAt.toISOString(),
    });
  }

  @OnEvent(WsEvent.DRIVER_REQUEST_EXPIRED)
  onOfferExpired(event: OfferLapsed): void {
    for (const driverId of event.driverIds ?? []) {
      this.emitter.toDriver(driverId, WsEvent.DRIVER_REQUEST_EXPIRED, { deliveryId: event.deliveryId });
    }
  }

  /** Someone else took it, or the customer changed their mind: clear the card. */
  @OnEvent(WsEvent.DRIVER_REQUEST_CANCELLED)
  onOfferCancelled(event: OfferLapsed): void {
    for (const driverId of event.driverIds ?? []) {
      if (driverId === event.exceptDriverId) continue;
      this.emitter.toDriver(driverId, WsEvent.DRIVER_REQUEST_CANCELLED, { deliveryId: event.deliveryId });
    }
  }

  /**
   * Live position to whoever is watching this delivery.
   *
   * Only into the delivery room: a driver's whereabouts are the business of
   * the customer whose package they are carrying, and nobody else.
   */
  @OnEvent(DomainEvent.DRIVER_LOCATION_REPORTED)
  onDriverMoved(event: LocationReported): void {
    this.emitter.toDelivery(event.deliveryId, WsEvent.DELIVERY_DRIVER_LOCATION_UPDATED, {
      deliveryId: event.deliveryId,
      latitude: event.latitude,
      longitude: event.longitude,
      heading: null,
      speed: null,
      at: new Date().toISOString(),
    });
  }

  private async customerUserId(customerId: string): Promise<string | null> {
    const profile = await this.prisma.customerProfile.findUnique({
      where: { id: customerId },
      select: { userId: true },
    });

    return profile?.userId ?? null;
  }
}
