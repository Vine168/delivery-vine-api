import { SetMetadata } from '@nestjs/common';
import { METADATA_KEY } from '../constants/app.constants.js';

/**
 * What a route needs the account to *be able to do*, rather than what it is.
 *
 * One person holds one mobile account and may both order deliveries and drive
 * for the platform, so `@Roles(DRIVER)` cannot express the gate any more: the
 * same principal is a customer on one screen and a driver on the next. What
 * separates them is which profile the account has, and — for the endpoints
 * that put a driver to work — whether that profile has been approved.
 *
 * Back-office access stays on `@Roles(ADMIN)`: an operator account is a
 * genuinely different account, not another capability of a mobile one.
 */
export type Capability = 'mobile' | 'customer' | 'driver' | 'approvedDriver';

/**
 * Any mobile account, whatever either side of it currently allows.
 *
 * For the routes that belong to neither side. Applying to drive is the
 * example: the caller is not a driver yet, and whether they may book has no
 * bearing on it — a customer barred from booking can still apply.
 */
export const RequiresMobileAccount = () => SetMetadata(METADATA_KEY.CAPABILITY, 'mobile' satisfies Capability);

/**
 * Requires a customer profile that may book — the account can order
 * deliveries. A customer an operator has suspended is refused with a code of
 * its own, so the app can say so rather than offer to sign them up.
 */
export const RequiresCustomer = () => SetMetadata(METADATA_KEY.CAPABILITY, 'customer' satisfies Capability);

/**
 * Requires a driver profile in any state, approved or not.
 *
 * This is the onboarding gate: someone who has applied must be able to fill in
 * their vehicle and upload documents precisely *because* they are not approved
 * yet. It also keeps a suspended driver's earnings and wallet readable — money
 * already earned is theirs whether or not they may still work.
 */
export const RequiresDriver = () => SetMetadata(METADATA_KEY.CAPABILITY, 'driver' satisfies Capability);

/**
 * Requires an approved driver profile — the account may actually work.
 *
 * Reserved for going online and for the job flow. Approval is re-read from the
 * database on every request rather than trusted from the token, so revoking it
 * takes effect immediately.
 */
export const RequiresApprovedDriver = () =>
  SetMetadata(METADATA_KEY.CAPABILITY, 'approvedDriver' satisfies Capability);
