import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface.js';
import { PrismaService } from '../../database/prisma.service.js';
import { DriverReadinessService } from '../drivers/driver-readiness.service.js';
import { FileUrlService } from '../uploads/file-url.service.js';
import type { MeDto } from './dto/me.dto.js';

/**
 * The one answer both apps need on launch: who is signed in, and what each
 * side of the account may do right now.
 *
 * Read from the database rather than the cached principal, so a suspension
 * or an approval shows the moment it happens, not a minute later.
 */
@Injectable()
export class MeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fileUrls: FileUrlService,
    private readonly readiness: DriverReadinessService,
  ) {}

  async find(principal: AuthenticatedUser): Promise<MeDto> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: principal.userId },
      select: {
        id: true,
        phone: true,
        email: true,
        status: true,
        customerProfile: { select: { id: true, fullName: true, avatarFileId: true, suspendedAt: true } },
        driverProfile: {
          select: {
            id: true,
            fullName: true,
            avatarFileId: true,
            approvalStatus: true,
            submittedAt: true,
            deletedAt: true,
          },
        },
      },
    });

    const customer = user.customerProfile;
    const driver = user.driverProfile && !user.driverProfile.deletedAt ? user.driverProfile : null;

    const [avatars, readiness] = await Promise.all([
      this.fileUrls.resolveMany([customer?.avatarFileId, driver?.avatarFileId]),
      driver ? this.readiness.evaluate(driver.id) : null,
    ]);

    const avatarUrl = (fileId: string | null | undefined): string | null =>
      fileId ? (avatars.get(fileId) ?? null) : null;

    return {
      account: {
        id: user.id,
        phone: user.phone,
        email: user.email,
        status: user.status,
        app: principal.app ?? null,
      },
      customer: customer
        ? {
            id: customer.id,
            fullName: customer.fullName,
            avatarUrl: avatarUrl(customer.avatarFileId),
            suspended: customer.suspendedAt !== null,
          }
        : null,
      driver:
        driver && readiness
          ? {
              id: driver.id,
              fullName: driver.fullName,
              avatarUrl: avatarUrl(driver.avatarFileId),
              approvalStatus: driver.approvalStatus,
              submittedAt: driver.submittedAt?.toISOString() ?? null,
              canGoOnline: readiness.canGoOnline,
              blockers: readiness.blockers,
            }
          : null,
    };
  }
}
