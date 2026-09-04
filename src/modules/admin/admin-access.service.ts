import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { RedisService } from '../../redis/redis.service.js';
import { PERMISSION_CATALOGUE } from './permissions.catalogue.js';

const PERMISSION_CACHE_TTL_SECONDS = 60;

export interface AdminAccess {
  adminId: string;
  fullName: string;
  isSuperAdmin: boolean;
  roleId: string | null;
  roleName: string | null;
  permissions: string[];
}

/**
 * What a back-office account is allowed to do.
 *
 * Permissions are resolved from the database rather than read out of the JWT,
 * so revoking a role takes effect within the cache window instead of when the
 * token happens to expire. The token still carries the list, because the
 * dashboard needs it to decide which screens to render — but the API never
 * trusts it.
 */
@Injectable()
export class AdminAccessService {
  private readonly logger = new Logger(AdminAccessService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async resolve(userId: string): Promise<AdminAccess | null> {
    const cacheKey = `admin:access:${userId}`;
    const cached = await this.redis.getJson<AdminAccess>(cacheKey);
    if (cached) return cached;

    const admin = await this.prisma.adminProfile.findFirst({
      where: { userId, deletedAt: null },
      select: {
        id: true,
        fullName: true,
        isSuperAdmin: true,
        roleId: true,
        role: {
          select: {
            name: true,
            deletedAt: true,
            permissions: { select: { permission: { select: { code: true } } } },
          },
        },
      },
    });

    if (!admin) return null;

    // A soft-deleted role grants nothing, rather than silently keeping its
    // last known permission set.
    const rolePermissions =
      admin.role && !admin.role.deletedAt
        ? admin.role.permissions.map((row) => row.permission.code)
        : [];

    const access: AdminAccess = {
      adminId: admin.id,
      fullName: admin.fullName,
      isSuperAdmin: admin.isSuperAdmin,
      roleId: admin.roleId,
      roleName: admin.role?.deletedAt ? null : (admin.role?.name ?? null),
      permissions: admin.isSuperAdmin ? this.allPermissionCodes() : rolePermissions,
    };

    await this.redis.setJson(cacheKey, access, PERMISSION_CACHE_TTL_SECONDS);
    return access;
  }

  /** Called whenever a role, its permissions, or an account's role changes. */
  async invalidate(userId: string): Promise<void> {
    await this.redis.client.del(`admin:access:${userId}`);
  }

  /** Role edits affect everyone holding it. */
  async invalidateRole(roleId: string): Promise<void> {
    const admins = await this.prisma.adminProfile.findMany({
      where: { roleId },
      select: { userId: true },
    });

    await Promise.all(admins.map((admin) => this.invalidate(admin.userId)));
  }

  has(access: AdminAccess, required: string[]): boolean {
    if (access.isSuperAdmin) return true;
    return required.every((permission) => access.permissions.includes(permission));
  }

  /**
   * A super admin is handed the whole catalogue, because the dashboard uses
   * this list to decide which screens to render. Authorisation itself still
   * turns on `isSuperAdmin`, so adding a permission never has to be
   * backfilled onto those accounts.
   */
  private allPermissionCodes(): string[] {
    return PERMISSION_CATALOGUE.map((permission) => permission.code);
  }
}
