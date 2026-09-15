import type { AuthenticatedUser } from '../interfaces/authenticated-user.interface.js';
import { DriverApprovalStatus } from '../../generated/prisma/enums.js';

/**
 * What a mobile account can do, derived from the profiles it holds.
 *
 * Shared by the route guard and by the upload rules so the two cannot drift:
 * a file purpose reserved for drivers and an endpoint reserved for drivers
 * should mean exactly the same thing.
 */
export const Capabilities = {
  /** Any mobile account. Back-office accounts hold neither profile. */
  mobile: (user: AuthenticatedUser): boolean => Boolean(user.customerId) || Boolean(user.driverId),

  /** Holds a customer profile an operator has not suspended — the account can order deliveries. */
  customer: (user: AuthenticatedUser): boolean => Boolean(user.customerId) && !user.customerSuspended,

  /** Has applied to drive, whatever the review has since decided. */
  driver: (user: AuthenticatedUser): boolean => Boolean(user.driverId),

  /** Approved to work. Re-read per request, never trusted from the token. */
  approvedDriver: (user: AuthenticatedUser): boolean =>
    Boolean(user.driverId) && user.driverApprovalStatus === DriverApprovalStatus.ACTIVE,
};
