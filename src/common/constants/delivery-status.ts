import { DeliveryStatus } from '../../generated/prisma/enums.js';

/** A delivery a driver is currently working, or one still looking for a driver. */
export const ACTIVE_DELIVERY_STATUSES = [
  DeliveryStatus.SEARCHING_DRIVER,
  DeliveryStatus.DRIVER_ASSIGNED,
  DeliveryStatus.ARRIVED_PICKUP,
  DeliveryStatus.PICKED_UP,
  DeliveryStatus.IN_TRANSIT,
  DeliveryStatus.ARRIVED_DROPOFF,
] as const;

/** Assigned to a driver — the driver is on the job. */
export const IN_FLIGHT_DELIVERY_STATUSES = [
  DeliveryStatus.DRIVER_ASSIGNED,
  DeliveryStatus.ARRIVED_PICKUP,
  DeliveryStatus.PICKED_UP,
  DeliveryStatus.IN_TRANSIT,
  DeliveryStatus.ARRIVED_DROPOFF,
] as const;

/** Nothing further can happen to these. */
export const TERMINAL_DELIVERY_STATUSES = [
  DeliveryStatus.DELIVERED,
  DeliveryStatus.CANCELLED,
  DeliveryStatus.EXPIRED,
] as const;

export const isActiveDelivery = (status: DeliveryStatus): boolean =>
  (ACTIVE_DELIVERY_STATUSES as readonly DeliveryStatus[]).includes(status);

export const isTerminalDelivery = (status: DeliveryStatus): boolean =>
  (TERMINAL_DELIVERY_STATUSES as readonly DeliveryStatus[]).includes(status);
