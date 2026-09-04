import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEvent } from '../../common/constants/events.js';
import { PrismaService } from '../../database/prisma.service.js';
import { DeliveryStatus, NotificationType, WithdrawalStatus } from '../../generated/prisma/enums.js';
import type { TransitionResult } from '../deliveries/delivery-state.service.js';
import { NotificationsService } from './notifications.service.js';

interface WithdrawalStatusChanged {
  withdrawalId: string;
  driverId: string;
  status: WithdrawalStatus;
}

/** What the customer is told at each stage, in their own terms. */
const CUSTOMER_MESSAGES: Partial<Record<DeliveryStatus, { type: NotificationType; title: string; body: (driver: string) => string }>> = {
  [DeliveryStatus.DRIVER_ASSIGNED]: {
    type: NotificationType.DRIVER_ASSIGNED,
    title: 'Driver on the way',
    body: (driver) => `${driver} is heading to collect your package.`,
  },
  [DeliveryStatus.ARRIVED_PICKUP]: {
    type: NotificationType.DRIVER_ARRIVED_PICKUP,
    title: 'Driver has arrived',
    body: (driver) => `${driver} is at the pickup point.`,
  },
  [DeliveryStatus.PICKED_UP]: {
    type: NotificationType.PACKAGE_PICKED_UP,
    title: 'Package collected',
    body: (driver) => `${driver} has your package and is on the way.`,
  },
  [DeliveryStatus.ARRIVED_DROPOFF]: {
    type: NotificationType.DRIVER_ARRIVED_DROPOFF,
    title: 'Driver has arrived',
    body: (driver) => `${driver} is at the drop-off point.`,
  },
  [DeliveryStatus.DELIVERED]: {
    type: NotificationType.DELIVERY_COMPLETED,
    title: 'Delivered',
    body: () => 'Your package has been delivered. Tap to rate your driver.',
  },
  [DeliveryStatus.CANCELLED]: {
    type: NotificationType.DELIVERY_CANCELLED,
    title: 'Delivery cancelled',
    body: () => 'Your delivery was cancelled.',
  },
  [DeliveryStatus.EXPIRED]: {
    type: NotificationType.DELIVERY_CANCELLED,
    title: 'No driver found',
    body: () => 'We could not find a driver. Please try again.',
  },
};

const WITHDRAWAL_MESSAGES: Partial<Record<WithdrawalStatus, { title: string; body: string }>> = {
  [WithdrawalStatus.SUCCESS]: { title: 'Payout sent', body: 'Your withdrawal has been transferred to your bank.' },
  [WithdrawalStatus.FAILED]: { title: 'Payout failed', body: 'Your withdrawal could not be completed. The money is back in your wallet.' },
  [WithdrawalStatus.REJECTED]: { title: 'Payout rejected', body: 'Your withdrawal request was rejected. The money is back in your wallet.' },
};

/**
 * Turns things that happened into things people are told.
 *
 * Every handler swallows its own failures: a notification is a courtesy, and
 * none of them may undo a delivery or a payout that has already committed.
 */
@Injectable()
export class NotificationsListener {
  private readonly logger = new Logger(NotificationsListener.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly prisma: PrismaService,
  ) {}

  @OnEvent(DomainEvent.DELIVERY_STATUS_CHANGED)
  async onDeliveryStatusChanged(event: TransitionResult): Promise<void> {
    const message = CUSTOMER_MESSAGES[event.to];
    if (!message) return;

    try {
      const delivery = await this.prisma.delivery.findUnique({
        where: { id: event.deliveryId },
        select: {
          bookingCode: true,
          customer: { select: { userId: true } },
          driver: { select: { fullName: true } },
        },
      });

      if (!delivery) return;

      await this.notifications.create({
        userId: delivery.customer.userId,
        type: message.type,
        title: message.title,
        body: message.body(delivery.driver?.fullName ?? 'Your driver'),
        deliveryId: event.deliveryId,
        data: { bookingCode: delivery.bookingCode, status: event.to },
      });
    } catch (error) {
      this.logger.error(`Could not notify for ${event.bookingCode}: ${String(error)}`);
    }
  }

  @OnEvent(DomainEvent.WITHDRAWAL_STATUS_CHANGED)
  async onWithdrawalStatusChanged(event: WithdrawalStatusChanged): Promise<void> {
    const message = WITHDRAWAL_MESSAGES[event.status];
    if (!message) return;

    try {
      const driver = await this.prisma.driverProfile.findUnique({
        where: { id: event.driverId },
        select: { userId: true },
      });

      if (!driver) return;

      await this.notifications.create({
        userId: driver.userId,
        type: NotificationType.WITHDRAWAL_STATUS_UPDATED,
        title: message.title,
        body: message.body,
        data: { withdrawalId: event.withdrawalId, status: event.status },
      });
    } catch (error) {
      this.logger.error(`Could not notify about withdrawal ${event.withdrawalId}: ${String(error)}`);
    }
  }
}
