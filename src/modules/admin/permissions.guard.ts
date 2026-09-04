import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface.js';
import { UserRole } from '../../generated/prisma/enums.js';
import { AdminAccessService, type AdminAccess } from './admin-access.service.js';
import { PERMISSIONS_KEY } from './require-permissions.decorator.js';

/** The principal, with the back-office context attached once resolved. */
export interface AdminRequest {
  user?: AuthenticatedUser;
  admin?: AdminAccess;
}

/**
 * Enforces the permission an endpoint declares.
 *
 * Registered globally so an admin route cannot opt out by omission: any handler
 * carrying `@RequirePermissions` is checked, and the permissions are read from
 * the database (cached briefly) rather than from the caller's token — a role
 * revoked a minute ago stops working, whatever the token still says.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: AdminAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const required = this.reflector.getAllAndOverride<string[] | undefined>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<AdminRequest>();
    const user = request.user;

    if (!user) throw AppException.unauthorized();

    if (user.role !== UserRole.ADMIN) {
      throw AppException.forbidden(
        ResponseCode.ROLE_NOT_ALLOWED,
        'Your account type cannot access the back office.',
      );
    }

    const access = await this.access.resolve(user.userId);

    if (!access) {
      // An ADMIN user with no back-office profile is a half-created account,
      // not an operator.
      throw AppException.forbidden(ResponseCode.FORBIDDEN, 'This account has no back-office profile.');
    }

    if (!this.access.has(access, required)) {
      throw AppException.forbidden(
        ResponseCode.FORBIDDEN,
        `You do not have permission to ${this.describe(required)}.`,
      );
    }

    // Handed to controllers so an action can be attributed without a re-read.
    request.admin = access;
    return true;
  }

  /** `deliveries.cancel` → "cancel deliveries", for a message an operator can act on. */
  private describe(permissions: string[]): string {
    return permissions
      .map((permission) => {
        const [module, action] = permission.split('.');
        return `${(action ?? 'use').replaceAll('_', ' ')} ${module}`;
      })
      .join(' and ');
  }
}
