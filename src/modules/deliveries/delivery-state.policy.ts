import { ActorType, DeliveryStatus } from '../../generated/prisma/enums.js';

/**
 * The delivery state machine, as data.
 *
 * Every transition the system permits is listed here once. Services ask this
 * policy; nothing anywhere else decides whether a status change is legal, and
 * the client's opinion of the current status is never consulted.
 */
export const ALLOWED_TRANSITIONS: Record<DeliveryStatus, readonly DeliveryStatus[]> = {
  [DeliveryStatus.DRAFT]: [DeliveryStatus.SEARCHING_DRIVER, DeliveryStatus.CANCELLED],
  [DeliveryStatus.SEARCHING_DRIVER]: [
    DeliveryStatus.DRIVER_ASSIGNED,
    DeliveryStatus.CANCELLED,
    DeliveryStatus.EXPIRED,
  ],
  [DeliveryStatus.DRIVER_ASSIGNED]: [
    DeliveryStatus.ARRIVED_PICKUP,
    DeliveryStatus.CANCELLED,
    // A driver who abandons the job releases it back to the pool.
    DeliveryStatus.SEARCHING_DRIVER,
  ],
  [DeliveryStatus.ARRIVED_PICKUP]: [
    DeliveryStatus.PICKED_UP,
    DeliveryStatus.CANCELLED,
    DeliveryStatus.SEARCHING_DRIVER,
  ],
  // Drivers who set off immediately may go straight to the drop-off.
  [DeliveryStatus.PICKED_UP]: [DeliveryStatus.IN_TRANSIT, DeliveryStatus.ARRIVED_DROPOFF, DeliveryStatus.CANCELLED],
  [DeliveryStatus.IN_TRANSIT]: [DeliveryStatus.ARRIVED_DROPOFF, DeliveryStatus.CANCELLED],
  [DeliveryStatus.ARRIVED_DROPOFF]: [DeliveryStatus.DELIVERED, DeliveryStatus.CANCELLED],
  [DeliveryStatus.DELIVERED]: [],
  [DeliveryStatus.CANCELLED]: [],
  [DeliveryStatus.EXPIRED]: [],
};

/**
 * Who may perform each transition.
 *
 * The important lines: a customer cannot cancel once the driver has the
 * package (that is a support case, not a tap), and a driver can only walk away
 * before pickup.
 */
const TRANSITION_ACTORS: Record<string, readonly ActorType[]> = {
  [key(DeliveryStatus.DRAFT, DeliveryStatus.SEARCHING_DRIVER)]: [ActorType.CUSTOMER, ActorType.SYSTEM],
  [key(DeliveryStatus.DRAFT, DeliveryStatus.CANCELLED)]: [ActorType.CUSTOMER, ActorType.ADMIN, ActorType.SYSTEM],

  [key(DeliveryStatus.SEARCHING_DRIVER, DeliveryStatus.DRIVER_ASSIGNED)]: [ActorType.DRIVER, ActorType.SYSTEM],
  [key(DeliveryStatus.SEARCHING_DRIVER, DeliveryStatus.CANCELLED)]: [ActorType.CUSTOMER, ActorType.ADMIN, ActorType.SYSTEM],
  [key(DeliveryStatus.SEARCHING_DRIVER, DeliveryStatus.EXPIRED)]: [ActorType.SYSTEM],

  [key(DeliveryStatus.DRIVER_ASSIGNED, DeliveryStatus.ARRIVED_PICKUP)]: [ActorType.DRIVER],
  [key(DeliveryStatus.DRIVER_ASSIGNED, DeliveryStatus.CANCELLED)]: [
    ActorType.CUSTOMER,
    ActorType.DRIVER,
    ActorType.ADMIN,
    ActorType.SYSTEM,
  ],
  [key(DeliveryStatus.DRIVER_ASSIGNED, DeliveryStatus.SEARCHING_DRIVER)]: [ActorType.DRIVER, ActorType.ADMIN, ActorType.SYSTEM],

  [key(DeliveryStatus.ARRIVED_PICKUP, DeliveryStatus.PICKED_UP)]: [ActorType.DRIVER],
  [key(DeliveryStatus.ARRIVED_PICKUP, DeliveryStatus.CANCELLED)]: [
    ActorType.CUSTOMER,
    ActorType.DRIVER,
    ActorType.ADMIN,
    ActorType.SYSTEM,
  ],
  [key(DeliveryStatus.ARRIVED_PICKUP, DeliveryStatus.SEARCHING_DRIVER)]: [ActorType.DRIVER, ActorType.ADMIN],

  [key(DeliveryStatus.PICKED_UP, DeliveryStatus.IN_TRANSIT)]: [ActorType.DRIVER, ActorType.SYSTEM],
  [key(DeliveryStatus.PICKED_UP, DeliveryStatus.ARRIVED_DROPOFF)]: [ActorType.DRIVER],
  // The package is already with the driver: only support can unwind this.
  [key(DeliveryStatus.PICKED_UP, DeliveryStatus.CANCELLED)]: [ActorType.ADMIN],

  [key(DeliveryStatus.IN_TRANSIT, DeliveryStatus.ARRIVED_DROPOFF)]: [ActorType.DRIVER],
  [key(DeliveryStatus.IN_TRANSIT, DeliveryStatus.CANCELLED)]: [ActorType.ADMIN],

  [key(DeliveryStatus.ARRIVED_DROPOFF, DeliveryStatus.DELIVERED)]: [ActorType.DRIVER],
  [key(DeliveryStatus.ARRIVED_DROPOFF, DeliveryStatus.CANCELLED)]: [ActorType.ADMIN],
};

function key(from: DeliveryStatus, to: DeliveryStatus): string {
  return `${from}->${to}`;
}

export function canTransition(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function actorCanTransition(from: DeliveryStatus, to: DeliveryStatus, actor: ActorType): boolean {
  if (!canTransition(from, to)) return false;
  return (TRANSITION_ACTORS[key(from, to)] ?? []).includes(actor);
}

/** Statuses this actor may cancel from — used to answer "can I cancel?" in the UI. */
export function cancellableBy(actor: ActorType): DeliveryStatus[] {
  return Object.keys(ALLOWED_TRANSITIONS)
    .filter((status) => actorCanTransition(status as DeliveryStatus, DeliveryStatus.CANCELLED, actor))
    .map((status) => status as DeliveryStatus);
}

/** Which statuses can precede a given one — the `where` clause of a safe update. */
export function statusesLeadingTo(to: DeliveryStatus): DeliveryStatus[] {
  return Object.entries(ALLOWED_TRANSITIONS)
    .filter(([, targets]) => targets.includes(to))
    .map(([from]) => from as DeliveryStatus);
}

/** The timestamp column a status sets when it is reached. */
export const STATUS_TIMESTAMP_FIELD: Partial<Record<DeliveryStatus, string>> = {
  [DeliveryStatus.SEARCHING_DRIVER]: 'confirmedAt',
  [DeliveryStatus.DRIVER_ASSIGNED]: 'assignedAt',
  [DeliveryStatus.ARRIVED_PICKUP]: 'arrivedPickupAt',
  [DeliveryStatus.PICKED_UP]: 'pickedUpAt',
  [DeliveryStatus.IN_TRANSIT]: 'inTransitAt',
  [DeliveryStatus.ARRIVED_DROPOFF]: 'arrivedDropoffAt',
  [DeliveryStatus.DELIVERED]: 'deliveredAt',
  [DeliveryStatus.CANCELLED]: 'cancelledAt',
  [DeliveryStatus.EXPIRED]: 'expiredAt',
};
