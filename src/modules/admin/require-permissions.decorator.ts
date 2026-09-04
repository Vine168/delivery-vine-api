import { SetMetadata, applyDecorators } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { UserRole } from '../../generated/prisma/enums.js';

export const PERMISSIONS_KEY = 'admin:permissions';

/**
 * Declares what an operator must be allowed to do to call this endpoint.
 *
 * Also applies the ADMIN role gate, so a back-office endpoint cannot be
 * written that checks permissions but forgets to exclude customers and
 * drivers. Several codes mean all of them are required.
 */
export const RequirePermissions = (...permissions: string[]) =>
  applyDecorators(
    SetMetadata(PERMISSIONS_KEY, permissions),
    Roles(UserRole.ADMIN),
    ApiBearerAuth(),
  );
