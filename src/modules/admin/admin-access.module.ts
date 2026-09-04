import { Global, Module } from '@nestjs/common';
import { AdminAccessService } from './admin-access.service.js';
import { ADMIN_PERMISSIONS_RESOLVER, adminPermissionsResolverProvider } from './admin-permissions.provider.js';
import { AuditService } from './audit.service.js';
import { PermissionsGuard } from './permissions.guard.js';

/**
 * Deliberately small and global: both the auth module (which stamps
 * permissions into the token) and every back-office module need this, and
 * keeping it separate from AdminModule avoids a cycle between them.
 */
@Global()
@Module({
  providers: [AdminAccessService, AuditService, PermissionsGuard, adminPermissionsResolverProvider],
  exports: [AdminAccessService, AuditService, PermissionsGuard, ADMIN_PERMISSIONS_RESOLVER],
})
export class AdminAccessModule {}
