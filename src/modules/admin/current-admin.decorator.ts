import { type ExecutionContext, createParamDecorator } from '@nestjs/common';
import { AppException } from '../../common/exceptions/app.exception.js';
import type { AdminAccess } from './admin-access.service.js';
import type { AdminRequest } from './permissions.guard.js';

/**
 * The back-office operator behind the request.
 *
 * Populated by PermissionsGuard, so it is only available on handlers that
 * declare a permission — which is every admin handler. Throwing rather than
 * returning undefined means a controller can never attribute an action to
 * nobody.
 */
export const CurrentAdmin = createParamDecorator(
  (property: keyof AdminAccess | undefined, context: ExecutionContext): AdminAccess | AdminAccess[keyof AdminAccess] => {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const admin = request.admin;

    if (!admin) {
      throw AppException.forbidden();
    }

    return property ? admin[property] : admin;
  },
);
