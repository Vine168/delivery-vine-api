import { Injectable } from '@nestjs/common';
import { ResponseCode } from '../../../common/constants/response-codes.js';
import { AppException } from '../../../common/exceptions/app.exception.js';
import { PrismaService } from '../../../database/prisma.service.js';
import { FileUrlService } from '../../uploads/file-url.service.js';
import { PERMISSION_CATALOGUE } from '../permissions.catalogue.js';
import type { AdminPermissionDto, AdminSessionDto } from '../dto/admin-session.dto.js';

@Injectable()
export class AdminSessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fileUrls: FileUrlService,
  ) {}

  /** Who the operator is and what they may do — the dashboard's first call. */
  async me(userId: string): Promise<AdminSessionDto> {
    const admin = await this.prisma.adminProfile.findFirst({
      where: { userId, deletedAt: null },
      select: {
        id: true,
        userId: true,
        fullName: true,
        avatarFileId: true,
        isSuperAdmin: true,
        lastLoginAt: true,
        user: { select: { phone: true, email: true } },
        role: {
          select: {
            id: true,
            name: true,
            slug: true,
            description: true,
            isSystem: true,
            deletedAt: true,
            _count: { select: { permissions: true } },
            permissions: { select: { permission: { select: { code: true } } } },
          },
        },
      },
    });

    if (!admin) {
      throw AppException.forbidden(ResponseCode.FORBIDDEN, 'This account has no back-office profile.');
    }

    const activeRole = admin.role && !admin.role.deletedAt ? admin.role : null;

    return {
      adminId: admin.id,
      userId: admin.userId,
      fullName: admin.fullName,
      phone: admin.user.phone,
      email: admin.user.email,
      avatarUrl: await this.fileUrls.resolveById(admin.avatarFileId),
      role: activeRole
        ? {
            id: activeRole.id,
            name: activeRole.name,
            slug: activeRole.slug,
            description: activeRole.description,
            isSystem: activeRole.isSystem,
            permissionCount: activeRole._count.permissions,
          }
        : null,
      isSuperAdmin: admin.isSuperAdmin,
      permissions: admin.isSuperAdmin
        ? PERMISSION_CATALOGUE.map((permission) => permission.code)
        : (activeRole?.permissions.map((row) => row.permission.code) ?? []),
      lastLoginAt: admin.lastLoginAt?.toISOString() ?? null,
    };
  }

  /** The catalogue, for the role editor. */
  async listPermissions(): Promise<AdminPermissionDto[]> {
    const permissions = await this.prisma.permission.findMany({
      orderBy: [{ module: 'asc' }, { code: 'asc' }],
      select: { code: true, module: true, action: true, description: true },
    });

    return permissions;
  }
}
