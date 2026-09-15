import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { METADATA_KEY } from '../constants/app.constants.js';
import { ResponseCode } from '../constants/response-codes.js';
import type { Capability } from '../decorators/capability.decorator.js';
import { AppException } from '../exceptions/app.exception.js';
import type { AuthenticatedUser } from '../interfaces/authenticated-user.interface.js';
import { DriverApprovalStatus } from '../../generated/prisma/enums.js';
import { Capabilities } from '../utils/capability.util.js';

/**
 * Gates a route on what the account can do, not what it is.
 *
 * Reads only the principal the JWT guard already resolved, so this costs no
 * query: the driver's approval status travels on the auth context, which is
 * invalidated whenever that status changes.
 *
 * Refusals name the specific blocker — "not applied" and "not approved yet"
 * send the driver app to different screens, and a flat 403 would leave it
 * guessing which.
 */
@Injectable()
export class CapabilityGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // HTTP only: a socket's principal lives on the connection, not a request.
    if (context.getType() !== 'http') return true;

    const required = this.reflector.getAllAndOverride<Capability | undefined>(METADATA_KEY.CAPABILITY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required) return true;

    const user = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>().user;
    if (!user) throw AppException.unauthorized();

    if (required === 'mobile') {
      if (!Capabilities.mobile(user)) {
        throw AppException.forbidden(ResponseCode.CUSTOMER_NOT_ENROLLED);
      }
      return true;
    }

    if (required === 'customer') {
      if (!Capabilities.customer(user)) {
        // Holding the profile and still refused means an operator stopped
        // them booking — the app shows that, not a sign-up screen.
        throw AppException.forbidden(
          user.customerId ? ResponseCode.CUSTOMER_BOOKING_SUSPENDED : ResponseCode.CUSTOMER_NOT_ENROLLED,
        );
      }
      return true;
    }

    if (!Capabilities.driver(user)) {
      throw AppException.forbidden(ResponseCode.DRIVER_NOT_ENROLLED);
    }

    if (required === 'approvedDriver') {
      this.assertApproved(user.driverApprovalStatus);
    }

    return true;
  }

  /** The same three outcomes the onboarding checklist reports, as refusals. */
  private assertApproved(status: DriverApprovalStatus | undefined): void {
    switch (status) {
      case DriverApprovalStatus.ACTIVE:
        return;
      case DriverApprovalStatus.SUSPENDED:
        throw AppException.forbidden(ResponseCode.DRIVER_SUSPENDED);
      case DriverApprovalStatus.REJECTED:
        throw AppException.forbidden(ResponseCode.DRIVER_REJECTED);
      default:
        throw AppException.forbidden(ResponseCode.DRIVER_NOT_APPROVED);
    }
  }
}
