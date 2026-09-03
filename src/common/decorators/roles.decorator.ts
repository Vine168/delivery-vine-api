import { SetMetadata } from '@nestjs/common';
import { METADATA_KEY } from '../constants/app.constants.js';
import type { UserRole } from '../../generated/prisma/enums.js';

/**
 * Restricts a route to the given account roles. Roles are coarse access
 * control only — resource ownership is always checked separately in services.
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(METADATA_KEY.ROLES, roles);
