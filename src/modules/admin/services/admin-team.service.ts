import { Injectable, Logger } from '@nestjs/common';
import { ResponseCode } from '../../../common/constants/response-codes.js';
import { AppException } from '../../../common/exceptions/app.exception.js';
import type { PaginatedResult } from '../../../common/interfaces/paginated.interface.js';
import { PaginationUtil } from '../../../common/utils/pagination.util.js';
import { PrismaService } from '../../../database/prisma.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { UserRole, UserStatus } from '../../../generated/prisma/enums.js';
import { PasswordService } from '../../auth/services/password.service.js';
import { TokenService } from '../../auth/services/token.service.js';
import { FileUrlService } from '../../uploads/file-url.service.js';
import { UsersService } from '../../users/users.service.js';
import { AdminAccessService } from '../admin-access.service.js';
import { AuditService } from '../audit.service.js';
import { PERMISSION_CATALOGUE, PERMISSIONS_BY_CODE } from '../permissions.catalogue.js';
import type {
  AdminAdministratorDto,
  AdminCreateAdministratorDto,
  AdminCreateRoleDto,
  AdminResetPasswordDto,
  AdminRoleDto,
  AdminTeamQueryDto,
  AdminUpdateAdministratorDto,
  AdminUpdateRoleDto,
} from '../dto/admin-team.dto.js';

const roleSelect = {
  id: true,
  name: true,
  slug: true,
  description: true,
  isSystem: true,
  createdAt: true,
  permissions: { select: { permission: { select: { code: true } } } },
  _count: { select: { admins: true } },
} as const;

const adminSelect = {
  id: true,
  userId: true,
  fullName: true,
  avatarFileId: true,
  isSuperAdmin: true,
  lastLoginAt: true,
  createdAt: true,
  user: { select: { phone: true, email: true, status: true } },
  role: { select: { id: true, name: true, _count: { select: { permissions: true } } } },
} as const;

/**
 * Who works in the back office, and what they may do.
 *
 * This is the module that can grant its own caller more power, so it carries
 * the rules that stop that happening: only a super admin may create another,
 * nobody may change their own authority or lock themselves out, and the last
 * super admin cannot be removed. Every one of those is enforced here rather
 * than in the guard, because they are about *who* is acting, not about which
 * permission the route needs.
 */
@Injectable()
export class AdminTeamService {
  private readonly logger = new Logger(AdminTeamService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly users: UsersService,
    private readonly access: AdminAccessService,
    private readonly fileUrls: FileUrlService,
    private readonly audit: AuditService,
  ) {}

  // ── Roles ──────────────────────────────────────────────────────────────

  async findRoles(): Promise<AdminRoleDto[]> {
    const roles = await this.prisma.role.findMany({
      where: { deletedAt: null },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      select: roleSelect,
    });

    return roles.map((role) => this.toRole(role));
  }

  async findRole(id: string): Promise<AdminRoleDto> {
    const role = await this.prisma.role.findFirst({
      where: { id, deletedAt: null },
      select: roleSelect,
    });

    if (!role) throw AppException.notFound(ResponseCode.ROLE_NOT_FOUND);
    return this.toRole(role);
  }

  async createRole(actorUserId: string, dto: AdminCreateRoleDto): Promise<AdminRoleDto> {
    const permissionIds = await this.resolvePermissions(dto.permissions);
    const slug = this.slugify(dto.name);

    const clash = await this.prisma.role.findFirst({ where: { slug, deletedAt: null } });
    if (clash) throw AppException.conflict(ResponseCode.ROLE_NAME_TAKEN);

    const created = await this.prisma.role.create({
      data: {
        name: dto.name,
        slug,
        description: dto.description,
        isSystem: false,
        permissions: { create: permissionIds.map((permissionId) => ({ permissionId })) },
      },
      select: { id: true },
    });

    await this.audit.record({
      actorUserId,
      action: 'role.create',
      entityType: 'Role',
      entityId: created.id,
      summary: `Created role ${dto.name} with ${dto.permissions.length} permission(s)`,
      after: { name: dto.name, permissions: dto.permissions },
    });

    return this.findRole(created.id);
  }

  /**
   * Edits a role.
   *
   * System roles are refused: the seed rewrites their permissions from the
   * platform's own catalogue, so an edit here would be silently undone on the
   * next deploy. Operators clone them into a role of their own instead.
   */
  async updateRole(actorUserId: string, id: string, dto: AdminUpdateRoleDto): Promise<AdminRoleDto> {
    const before = await this.findRole(id);
    this.assertEditable(before);

    if (dto.name && dto.name !== before.name) {
      const slug = this.slugify(dto.name);
      const clash = await this.prisma.role.findFirst({ where: { slug, deletedAt: null, NOT: { id } } });
      if (clash) throw AppException.conflict(ResponseCode.ROLE_NAME_TAKEN);
    }

    const permissionIds = dto.permissions ? await this.resolvePermissions(dto.permissions) : null;

    await this.prisma.$transaction(async (tx) => {
      await tx.role.update({
        where: { id },
        data: {
          ...(dto.name ? { name: dto.name, slug: this.slugify(dto.name) } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
        },
      });

      if (permissionIds) {
        await tx.rolePermission.deleteMany({ where: { roleId: id } });
        await tx.rolePermission.createMany({
          data: permissionIds.map((permissionId) => ({ roleId: id, permissionId })),
        });
      }
    });

    // Whoever holds this role is using a cached copy of what they may do.
    await this.access.invalidateRole(id);

    await this.audit.record({
      actorUserId,
      action: 'role.update',
      entityType: 'Role',
      entityId: id,
      summary: `Updated role ${before.name}`,
      before: { name: before.name, permissions: before.permissions.map((p) => p.code) },
      after: { name: dto.name ?? before.name, permissions: dto.permissions },
    });

    return this.findRole(id);
  }

  /** Removes a role nobody holds. Soft, so audit entries stay explicable. */
  async deleteRole(actorUserId: string, id: string): Promise<void> {
    const role = await this.findRole(id);
    this.assertEditable(role);

    if (role.adminCount > 0) {
      throw AppException.conflict(
        ResponseCode.ROLE_IN_USE,
        `${role.adminCount} operator(s) hold this role. Move them to another role first.`,
      );
    }

    await this.prisma.role.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.access.invalidateRole(id);

    await this.audit.record({
      actorUserId,
      action: 'role.delete',
      entityType: 'Role',
      entityId: id,
      summary: `Deleted role ${role.name}`,
      before: { name: role.name, permissions: role.permissions.map((p) => p.code) },
    });
  }

  // ── Administrators ─────────────────────────────────────────────────────

  async findAdministrators(query: AdminTeamQueryDto): Promise<PaginatedResult<AdminAdministratorDto>> {
    const where: Prisma.AdminProfileWhereInput = {
      deletedAt: null,
      ...(query.roleId ? { roleId: query.roleId } : {}),
      ...(query.status ? { user: { status: query.status } } : {}),
      ...(query.search
        ? {
            OR: [
              { fullName: { contains: query.search, mode: 'insensitive' } },
              { user: { phone: { contains: query.search } } },
              { user: { email: { contains: query.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.adminProfile.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
        select: adminSelect,
      }),
      this.prisma.adminProfile.count({ where }),
    ]);

    const avatars = await this.fileUrls.resolveMany(rows.map((row) => row.avatarFileId));

    return PaginationUtil.paginate(
      rows.map((row) => this.toAdministrator(row, avatars)),
      query.page,
      query.limit,
      total,
    );
  }

  async findAdministrator(id: string): Promise<AdminAdministratorDto> {
    const admin = await this.prisma.adminProfile.findFirst({
      where: { id, deletedAt: null },
      select: adminSelect,
    });

    if (!admin) throw AppException.notFound(ResponseCode.ADMIN_NOT_FOUND);

    const avatars = await this.fileUrls.resolveMany([admin.avatarFileId]);
    return this.toAdministrator(admin, avatars);
  }

  /**
   * Adds an operator.
   *
   * There is no self-registration for the back office and no invitation email
   * yet, so the creating operator sets the first password and hands it over.
   * It is hashed immediately and never returned by any endpoint — including
   * this one.
   */
  async create(actorUserId: string, dto: AdminCreateAdministratorDto): Promise<AdminAdministratorDto> {
    const role = await this.findRole(dto.roleId);

    const existing = await this.prisma.user.findFirst({
      where: { phone: dto.phone, role: UserRole.ADMIN, deletedAt: null },
      select: { id: true },
    });
    if (existing) throw AppException.conflict(ResponseCode.ACCOUNT_ALREADY_EXISTS);

    const passwordHash = await this.passwords.hash(dto.password);

    const created = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          phone: dto.phone,
          email: dto.email,
          role: UserRole.ADMIN,
          status: UserStatus.ACTIVE,
          passwordHash,
          // A back-office account is vouched for by the operator creating it;
          // there is no OTP step to verify.
          phoneVerifiedAt: new Date(),
        },
        select: { id: true },
      });

      return tx.adminProfile.create({
        data: { userId: user.id, fullName: dto.fullName, roleId: dto.roleId, isSuperAdmin: false },
        select: { id: true },
      });
    });

    await this.audit.record({
      actorUserId,
      action: 'admin.create',
      entityType: 'AdminProfile',
      entityId: created.id,
      summary: `Added operator ${dto.fullName} as ${role.name}`,
      after: { fullName: dto.fullName, phone: dto.phone, roleId: dto.roleId },
    });

    return this.findAdministrator(created.id);
  }

  async update(
    actorUserId: string,
    actorIsSuperAdmin: boolean,
    id: string,
    dto: AdminUpdateAdministratorDto,
  ): Promise<AdminAdministratorDto> {
    const before = await this.findAdministrator(id);
    const isSelf = before.userId === actorUserId;

    if (dto.isSuperAdmin !== undefined && dto.isSuperAdmin !== before.isSuperAdmin) {
      // Unrestricted access is granted by someone who already has it, never
      // taken. Otherwise `admins.manage` would be a route to every permission.
      if (!actorIsSuperAdmin) {
        throw AppException.forbidden(
          ResponseCode.SUPER_ADMIN_REQUIRED,
          'Only a super admin can grant or revoke unrestricted access.',
        );
      }
      if (isSelf) {
        throw AppException.forbidden(
          ResponseCode.CANNOT_MODIFY_SELF,
          'You cannot change your own level of access.',
        );
      }
      if (before.isSuperAdmin) await this.assertNotLastSuperAdmin(id);
    }

    if (dto.roleId && dto.roleId !== before.roleId) {
      await this.findRole(dto.roleId);
      if (isSelf) {
        throw AppException.forbidden(
          ResponseCode.CANNOT_MODIFY_SELF,
          'You cannot change your own role. Ask another operator.',
        );
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.adminProfile.update({
        where: { id },
        data: {
          ...(dto.fullName ? { fullName: dto.fullName } : {}),
          ...(dto.roleId ? { roleId: dto.roleId } : {}),
          ...(dto.isSuperAdmin !== undefined ? { isSuperAdmin: dto.isSuperAdmin } : {}),
        },
      });

      if (dto.email !== undefined) {
        await tx.user.update({ where: { id: before.userId }, data: { email: dto.email } });
      }
    });

    await this.access.invalidate(before.userId);

    await this.audit.record({
      actorUserId,
      action: 'admin.update',
      entityType: 'AdminProfile',
      entityId: id,
      summary: `Updated operator ${before.fullName}`,
      before: { roleId: before.roleId, isSuperAdmin: before.isSuperAdmin, fullName: before.fullName },
      after: { ...dto },
    });

    return this.findAdministrator(id);
  }

  /**
   * Stops an operator signing in.
   *
   * Refused on your own account and on the last super admin — both are ways to
   * lock everybody out of the back office with a single click, and neither has
   * a recovery path short of database access.
   */
  async suspend(actorUserId: string, id: string, reason: string): Promise<AdminAdministratorDto> {
    const admin = await this.findAdministrator(id);

    if (admin.userId === actorUserId) {
      throw AppException.forbidden(
        ResponseCode.CANNOT_MODIFY_SELF,
        'You cannot suspend your own account.',
      );
    }
    if (admin.isSuperAdmin) await this.assertNotLastSuperAdmin(id);

    await this.prisma.user.update({
      where: { id: admin.userId },
      data: { status: UserStatus.SUSPENDED, suspendedReason: reason },
    });

    await this.tokens.revokeAllSessions(admin.userId);
    await this.users.invalidateAuthContext(admin.userId);
    await this.access.invalidate(admin.userId);

    await this.audit.record({
      actorUserId,
      action: 'admin.suspend',
      entityType: 'AdminProfile',
      entityId: id,
      summary: `Suspended operator ${admin.fullName}: ${reason}`,
      before: { status: admin.status },
      after: { status: UserStatus.SUSPENDED, reason },
    });

    return this.findAdministrator(id);
  }

  async reinstate(actorUserId: string, id: string): Promise<AdminAdministratorDto> {
    const admin = await this.findAdministrator(id);

    if (admin.status !== UserStatus.SUSPENDED) {
      throw AppException.conflict(ResponseCode.CONFLICT, 'This operator is not suspended.');
    }

    await this.prisma.user.update({
      where: { id: admin.userId },
      data: { status: UserStatus.ACTIVE, suspendedReason: null },
    });
    await this.users.invalidateAuthContext(admin.userId);

    await this.audit.record({
      actorUserId,
      action: 'admin.reinstate',
      entityType: 'AdminProfile',
      entityId: id,
      summary: `Reinstated operator ${admin.fullName}`,
      before: { status: UserStatus.SUSPENDED },
      after: { status: UserStatus.ACTIVE },
    });

    return this.findAdministrator(id);
  }

  /**
   * Sets a new password for an operator who has lost theirs.
   *
   * Every session is revoked with it: if the password had to be reset because
   * it was compromised, leaving the old sessions alive defeats the point.
   */
  async resetPassword(
    actorUserId: string,
    id: string,
    dto: AdminResetPasswordDto,
  ): Promise<AdminAdministratorDto> {
    const admin = await this.findAdministrator(id);
    const passwordHash = await this.passwords.hash(dto.password);

    await this.prisma.user.update({ where: { id: admin.userId }, data: { passwordHash } });
    await this.tokens.revokeAllSessions(admin.userId);
    await this.users.invalidateAuthContext(admin.userId);

    await this.audit.record({
      actorUserId,
      action: 'admin.password.reset',
      entityType: 'AdminProfile',
      entityId: id,
      // The password itself never reaches the audit log.
      summary: `Reset the password for ${admin.fullName} and ended their sessions`,
    });

    return this.findAdministrator(id);
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async resolvePermissions(codes: string[]): Promise<string[]> {
    const wanted = [...new Set(codes)];
    const unknown = wanted.filter((code) => !PERMISSIONS_BY_CODE.has(code));

    if (unknown.length > 0) {
      throw AppException.unprocessable(
        ResponseCode.PERMISSION_NOT_FOUND,
        `Unknown permission(s): ${unknown.join(', ')}.`,
      );
    }

    const rows = await this.prisma.permission.findMany({
      where: { code: { in: wanted } },
      select: { id: true, code: true },
    });

    // The catalogue is the source of truth, but the rows are what a role links
    // to; a permission added in code and not yet seeded would silently vanish.
    if (rows.length !== wanted.length) {
      const missing = wanted.filter((code) => !rows.some((row) => row.code === code));
      throw AppException.unprocessable(
        ResponseCode.PERMISSION_NOT_FOUND,
        `These permissions are not installed yet: ${missing.join(', ')}. Run the seed.`,
      );
    }

    return rows.map((row) => row.id);
  }

  private assertEditable(role: AdminRoleDto): void {
    if (role.isSystem) {
      throw AppException.forbidden(
        ResponseCode.ROLE_IS_SYSTEM,
        `${role.name} is a system role and cannot be changed. Create a role of your own with the permissions you need.`,
      );
    }
  }

  private async assertNotLastSuperAdmin(excludingId: string): Promise<void> {
    const others = await this.prisma.adminProfile.count({
      where: {
        isSuperAdmin: true,
        deletedAt: null,
        user: { status: UserStatus.ACTIVE, deletedAt: null },
        NOT: { id: excludingId },
      },
    });

    if (others === 0) {
      throw AppException.conflict(
        ResponseCode.LAST_SUPER_ADMIN,
        'This is the only super admin. Promote someone else first, or nobody will be able to administer the platform.',
      );
    }
  }

  private toRole(role: Prisma.RoleGetPayload<{ select: typeof roleSelect }>): AdminRoleDto {
    const codes = new Set(role.permissions.map((link) => link.permission.code));

    return {
      id: role.id,
      name: role.name,
      slug: role.slug,
      description: role.description,
      isSystem: role.isSystem,
      // Described from the catalogue so the editor always renders a module and
      // an action, even for a permission whose description has since changed.
      permissions: PERMISSION_CATALOGUE.filter((permission) => codes.has(permission.code)),
      adminCount: role._count.admins,
      createdAt: role.createdAt.toISOString(),
    };
  }

  private toAdministrator(
    row: Prisma.AdminProfileGetPayload<{ select: typeof adminSelect }>,
    avatars: Map<string, string>,
  ): AdminAdministratorDto {
    return {
      id: row.id,
      userId: row.userId,
      fullName: row.fullName,
      phone: row.user.phone,
      email: row.user.email,
      avatarUrl: row.avatarFileId ? (avatars.get(row.avatarFileId) ?? null) : null,
      status: row.user.status,
      roleId: row.role?.id ?? null,
      roleName: row.role?.name ?? null,
      isSuperAdmin: row.isSuperAdmin,
      permissionCount: row.isSuperAdmin ? PERMISSION_CATALOGUE.length : (row.role?._count.permissions ?? 0),
      lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
}
