import { describe, expect, it } from 'vitest';
import { ActorType, DeliveryStatus } from '../../generated/prisma/enums.js';
import {
  ALLOWED_TRANSITIONS,
  STATUS_TIMESTAMP_FIELD,
  actorCanTransition,
  canTransition,
  cancellableBy,
  statusesLeadingTo,
} from './delivery-state.policy.js';

const ALL_STATUSES = Object.values(DeliveryStatus);

describe('delivery state machine', () => {
  describe('the happy path', () => {
    const path = [
      DeliveryStatus.DRAFT,
      DeliveryStatus.SEARCHING_DRIVER,
      DeliveryStatus.DRIVER_ASSIGNED,
      DeliveryStatus.ARRIVED_PICKUP,
      DeliveryStatus.PICKED_UP,
      DeliveryStatus.IN_TRANSIT,
      DeliveryStatus.ARRIVED_DROPOFF,
      DeliveryStatus.DELIVERED,
    ];

    it('walks from booking to delivered', () => {
      for (let i = 1; i < path.length; i += 1) {
        expect(canTransition(path[i - 1], path[i]), `${path[i - 1]} → ${path[i]}`).toBe(true);
      }
    });

    it('lets a driver go straight from pickup to the drop-off', () => {
      expect(canTransition(DeliveryStatus.PICKED_UP, DeliveryStatus.ARRIVED_DROPOFF)).toBe(true);
    });
  });

  describe('illegal moves', () => {
    it('refuses to skip ahead', () => {
      expect(canTransition(DeliveryStatus.SEARCHING_DRIVER, DeliveryStatus.DELIVERED)).toBe(false);
      expect(canTransition(DeliveryStatus.DRIVER_ASSIGNED, DeliveryStatus.PICKED_UP)).toBe(false);
      expect(canTransition(DeliveryStatus.DRAFT, DeliveryStatus.DRIVER_ASSIGNED)).toBe(false);
      expect(canTransition(DeliveryStatus.ARRIVED_PICKUP, DeliveryStatus.ARRIVED_DROPOFF)).toBe(false);
    });

    it('refuses to go backwards through the delivery', () => {
      expect(canTransition(DeliveryStatus.PICKED_UP, DeliveryStatus.ARRIVED_PICKUP)).toBe(false);
      expect(canTransition(DeliveryStatus.DELIVERED, DeliveryStatus.IN_TRANSIT)).toBe(false);
      expect(canTransition(DeliveryStatus.ARRIVED_DROPOFF, DeliveryStatus.PICKED_UP)).toBe(false);
    });

    it('treats DELIVERED, CANCELLED and EXPIRED as final', () => {
      for (const terminal of [DeliveryStatus.DELIVERED, DeliveryStatus.CANCELLED, DeliveryStatus.EXPIRED]) {
        expect(ALLOWED_TRANSITIONS[terminal]).toHaveLength(0);

        for (const target of ALL_STATUSES) {
          expect(canTransition(terminal, target), `${terminal} → ${target}`).toBe(false);
        }
      }
    });

    it('never allows a status to transition to itself', () => {
      for (const status of ALL_STATUSES) {
        expect(canTransition(status, status), status).toBe(false);
      }
    });
  });

  describe('who may do what', () => {
    it('only the driver reports progress on the road', () => {
      const driverOnly: [DeliveryStatus, DeliveryStatus][] = [
        [DeliveryStatus.DRIVER_ASSIGNED, DeliveryStatus.ARRIVED_PICKUP],
        [DeliveryStatus.ARRIVED_PICKUP, DeliveryStatus.PICKED_UP],
        [DeliveryStatus.IN_TRANSIT, DeliveryStatus.ARRIVED_DROPOFF],
        [DeliveryStatus.ARRIVED_DROPOFF, DeliveryStatus.DELIVERED],
      ];

      for (const [from, to] of driverOnly) {
        expect(actorCanTransition(from, to, ActorType.DRIVER), `driver ${from}→${to}`).toBe(true);
        expect(actorCanTransition(from, to, ActorType.CUSTOMER), `customer ${from}→${to}`).toBe(false);
      }
    });

    it('lets a customer cancel only before the package is collected', () => {
      const customerCancellable = cancellableBy(ActorType.CUSTOMER);

      expect(customerCancellable).toEqual(
        expect.arrayContaining([
          DeliveryStatus.DRAFT,
          DeliveryStatus.SEARCHING_DRIVER,
          DeliveryStatus.DRIVER_ASSIGNED,
          DeliveryStatus.ARRIVED_PICKUP,
        ]),
      );

      expect(customerCancellable).not.toContain(DeliveryStatus.PICKED_UP);
      expect(customerCancellable).not.toContain(DeliveryStatus.IN_TRANSIT);
      expect(customerCancellable).not.toContain(DeliveryStatus.ARRIVED_DROPOFF);
    });

    it('lets a driver walk away only before pickup', () => {
      const driverCancellable = cancellableBy(ActorType.DRIVER);

      expect(driverCancellable).toContain(DeliveryStatus.DRIVER_ASSIGNED);
      expect(driverCancellable).toContain(DeliveryStatus.ARRIVED_PICKUP);
      expect(driverCancellable).not.toContain(DeliveryStatus.PICKED_UP);
      expect(driverCancellable).not.toContain(DeliveryStatus.IN_TRANSIT);
    });

    it('leaves a package already in transit to support', () => {
      for (const from of [DeliveryStatus.PICKED_UP, DeliveryStatus.IN_TRANSIT, DeliveryStatus.ARRIVED_DROPOFF]) {
        expect(actorCanTransition(from, DeliveryStatus.CANCELLED, ActorType.ADMIN)).toBe(true);
        expect(actorCanTransition(from, DeliveryStatus.CANCELLED, ActorType.CUSTOMER)).toBe(false);
        expect(actorCanTransition(from, DeliveryStatus.CANCELLED, ActorType.DRIVER)).toBe(false);
      }
    });

    it('only the system expires a search', () => {
      expect(actorCanTransition(DeliveryStatus.SEARCHING_DRIVER, DeliveryStatus.EXPIRED, ActorType.SYSTEM)).toBe(true);
      expect(actorCanTransition(DeliveryStatus.SEARCHING_DRIVER, DeliveryStatus.EXPIRED, ActorType.CUSTOMER)).toBe(false);
      expect(actorCanTransition(DeliveryStatus.SEARCHING_DRIVER, DeliveryStatus.EXPIRED, ActorType.DRIVER)).toBe(false);
    });

    it('never lets a customer assign a driver to their own booking', () => {
      expect(
        actorCanTransition(DeliveryStatus.SEARCHING_DRIVER, DeliveryStatus.DRIVER_ASSIGNED, ActorType.CUSTOMER),
      ).toBe(false);
    });
  });

  describe('policy completeness', () => {
    it('gives every status an entry, so a new one cannot be forgotten', () => {
      for (const status of ALL_STATUSES) {
        expect(ALLOWED_TRANSITIONS[status]).toBeDefined();
      }
    });

    it('grants at least one actor to every legal transition', () => {
      for (const [from, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
        for (const to of targets) {
          const actors = Object.values(ActorType).filter((actor) =>
            actorCanTransition(from as DeliveryStatus, to, actor),
          );
          expect(actors.length, `${from} → ${to} has no permitted actor`).toBeGreaterThan(0);
        }
      }
    });

    it('knows which statuses precede a given one', () => {
      expect(statusesLeadingTo(DeliveryStatus.DELIVERED)).toEqual([DeliveryStatus.ARRIVED_DROPOFF]);
      expect(statusesLeadingTo(DeliveryStatus.DRIVER_ASSIGNED)).toEqual([DeliveryStatus.SEARCHING_DRIVER]);
      expect(statusesLeadingTo(DeliveryStatus.CANCELLED).length).toBeGreaterThan(4);
    });

    it('stamps a timestamp for every status a delivery can reach', () => {
      for (const status of ALL_STATUSES) {
        if (status === DeliveryStatus.DRAFT) continue; // the row's createdAt covers it
        expect(STATUS_TIMESTAMP_FIELD[status], status).toBeDefined();
      }
    });
  });
});
