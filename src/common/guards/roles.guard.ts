import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { METADATA_KEY } from '../constants/app.constants.js';
import { ResponseCode } from '../constants/response-codes.js';
import { AppException } from '../exceptions/app.exception.js';
import type { AuthenticatedUser } from '../interfaces/authenticated-user.interface.js';
import type { UserRole } from '../../generated/prisma/enums.js';

/**
 * Coarse role gate. Ownership of a specific resource is never decided here —
 * services always re-check that the row belongs to the caller.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(METADATA_KEY.ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) return true;

    const user = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>().user;
    if (!user) throw AppException.unauthorized();

    if (!required.includes(user.role)) {
      throw AppException.forbidden(
        ResponseCode.ROLE_NOT_ALLOWED,
        'Your account type cannot access this resource.',
      );
    }

    return true;
  }
}
