import type { Provider } from '@nestjs/common';
import { AdminAccessService } from './admin-access.service.js';

/**
 * Resolves a back-office account's permission codes.
 *
 * Provided as a function behind a token so the auth module can stamp
 * permissions into a token without importing the back office — auth stays
 * ignorant of what an operator is allowed to do, and only the admin module
 * knows how that is decided.
 */
export const ADMIN_PERMISSIONS_RESOLVER = Symbol('ADMIN_PERMISSIONS_RESOLVER');

export type AdminPermissionsResolver = (userId: string) => Promise<string[] | undefined>;

export const adminPermissionsResolverProvider: Provider = {
  provide: ADMIN_PERMISSIONS_RESOLVER,
  inject: [AdminAccessService],
  useFactory:
    (access: AdminAccessService): AdminPermissionsResolver =>
    async (userId: string) => {
      const resolved = await access.resolve(userId);
      return resolved?.permissions;
    },
};
