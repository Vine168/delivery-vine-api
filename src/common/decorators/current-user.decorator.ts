import { type ExecutionContext, createParamDecorator } from '@nestjs/common';
import { AppException } from '../exceptions/app.exception.js';
import { ResponseCode } from '../constants/response-codes.js';
import type { AuthenticatedUser } from '../interfaces/authenticated-user.interface.js';

/**
 * Injects the authenticated principal.
 *
 * `@CurrentUser()` → the whole object.
 * `@CurrentUser('driverId')` → that property, and it throws rather than
 * returning undefined, so a controller can never silently operate on
 * `undefined` as an id.
 */
export const CurrentUser = createParamDecorator(
  (property: keyof AuthenticatedUser | undefined, context: ExecutionContext) => {
    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;

    if (!user) {
      throw AppException.unauthorized();
    }

    if (!property) return user;

    const value = user[property];
    if (value === undefined || value === null) {
      throw AppException.forbidden(
        ResponseCode.ROLE_NOT_ALLOWED,
        `This endpoint requires a ${String(property).replace('Id', '')} account.`,
      );
    }
    return value;
  },
);
