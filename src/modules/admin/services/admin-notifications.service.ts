import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { JOB, QUEUE } from '../../../common/constants/queues.js';
import { ResponseCode } from '../../../common/constants/response-codes.js';
import { AppException } from '../../../common/exceptions/app.exception.js';
import type { PaginatedResult } from '../../../common/interfaces/paginated.interface.js';
import { PaginationUtil } from '../../../common/utils/pagination.util.js';
import { PrismaService } from '../../../database/prisma.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import {
  CampaignAudience,
  CampaignStatus,
  DriverApprovalStatus,
  NotificationType,
  UserRole,
  UserStatus,
} from '../../../generated/prisma/enums.js';
import { DriverPresenceService } from '../../driver-presence/driver-presence.service.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { AuditService } from '../audit.service.js';
import type {
  AdminAudienceDto,
  AdminAudiencePreviewDto,
  AdminCampaignDto,
  AdminCampaignQueryDto,
  AdminNotificationQueryDto,
  AdminNotificationRowDto,
  AdminSendNotificationDto,
} from '../dto/admin-notification.dto.js';

const campaignSelect = {
  id: true,
  title: true,
  body: true,
  type: true,
  audience: true,
  filters: true,
  status: true,
  totalRecipients: true,
  sentCount: true,
  failedCount: true,
  failureReason: true,
  startedAt: true,
  completedAt: true,
  createdAt: true,
  createdBy: { select: { adminProfile: { select: { fullName: true } } } },
} as const;

export interface CampaignJob {
  campaignId: string;
}

/**
 * How many recipients are notified before progress is written back. Small
 * enough that a crash loses little, large enough that a broadcast to
 * thousands is not thousands of extra updates.
 */
const PROGRESS_BATCH = 50;

const campaignJobId = (campaignId: string): string => `campaign-${campaignId}`;

/**
 * Operator-initiated notifications.
 *
 * A broadcast is not one action — it is thousands of rows and thousands of
 * push attempts — so nothing is sent on the request thread. The campaign is
 * recorded, the request returns, and a worker fans it out in batches, keeping
 * counters as it goes. That is also what makes a send that failed halfway
 * explicable: the campaign says how far it got and why it stopped.
 *
 * Audiences are resolved when the send begins, not when it was composed. A
 * message to online drivers reaches whoever is working at that moment, which
 * is what the person writing it meant.
 */
@Injectable()
export class AdminNotificationsService {
  private readonly logger = new Logger(AdminNotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: DriverPresenceService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    @InjectQueue(QUEUE.NOTIFICATION) private readonly queue: Queue,
  ) {}

  /**
   * How many people an audience currently covers.
   *
   * Called before sending, so nobody discovers the size of "all customers"
   * only after pressing the button.
   */
  async preview(dto: AdminAudienceDto): Promise<AdminAudiencePreviewDto> {
    const userIds = await this.resolveAudience(dto);

    const reachable =
      userIds.length === 0
        ? 0
        : await this.prisma.device.count({
            where: { userId: { in: userIds }, pushTokens: { some: { isActive: true } } },
          });

    return {
      audience: dto.audience,
      recipientCount: userIds.length,
      reachableByPush: reachable,
    };
  }

  async send(actorUserId: string, dto: AdminSendNotificationDto): Promise<AdminCampaignDto> {
    // Validated before anything is written, so a bad zone id fails as a
    // request error rather than a campaign that immediately dies.
    await this.assertAudienceValid(dto);

    const campaign = await this.prisma.notificationCampaign.create({
      data: {
        title: dto.title,
        body: dto.body,
        type: dto.type ?? NotificationType.SYSTEM_ANNOUNCEMENT,
        audience: dto.audience,
        filters: this.filtersFor(dto),
        data: (dto.data ?? undefined) as Prisma.InputJsonValue | undefined,
        status: CampaignStatus.QUEUED,
        createdByUserId: actorUserId,
      },
      select: { id: true },
    });

    await this.queue.add(
      JOB.SEND_CAMPAIGN,
      { campaignId: campaign.id } satisfies CampaignJob,
      // Dashes, not colons: BullMQ reserves the colon for its own key
      // namespace and refuses a custom id containing one.
      { jobId: campaignJobId(campaign.id) },
    );

    await this.audit.record({
      actorUserId,
      action: 'notification.send',
      entityType: 'NotificationCampaign',
      entityId: campaign.id,
      summary: `Queued "${dto.title}" to ${dto.audience.toLowerCase().replaceAll('_', ' ')}`,
      after: { audience: dto.audience, title: dto.title },
    });

    return this.findCampaign(campaign.id);
  }


  /**
   * Sends a queued campaign.
   *
   * Deliberately sequential rather than parallel: this shares a database and a
   * push provider with the delivery flow, and a marketing blast must never be
   * the reason a driver's job offer is late. One recipient failing is counted
   * and the rest still go out. Progress is written back periodically so a send
   * that stops halfway is explicable rather than mysterious.
   */
  async deliver(campaignId: string): Promise<void> {
    const campaign = await this.prisma.notificationCampaign.findUnique({ where: { id: campaignId } });

    if (!campaign) {
      this.logger.warn(`Campaign ${campaignId} no longer exists`);
      return;
    }

    // Cancelled between queueing and running, or already picked up elsewhere:
    // a conditional update settles which, without a lock.
    const { count } = await this.prisma.notificationCampaign.updateMany({
      where: { id: campaignId, status: CampaignStatus.QUEUED },
      data: { status: CampaignStatus.SENDING, startedAt: new Date() },
    });

    if (count === 0) {
      this.logger.log(`Campaign ${campaignId} is ${campaign.status}; nothing to send`);
      return;
    }

    try {
      const filters = (campaign.filters ?? {}) as { zoneId?: string; userIds?: string[] };
      const recipients = await this.resolveAudience({
        audience: campaign.audience,
        zoneId: filters.zoneId,
        userIds: filters.userIds,
      });

      await this.prisma.notificationCampaign.update({
        where: { id: campaignId },
        data: { totalRecipients: recipients.length },
      });

      let sent = 0;
      let failed = 0;

      for (const [index, userId] of recipients.entries()) {
        try {
          await this.notifications.create({
            userId,
            type: campaign.type,
            title: campaign.title,
            body: campaign.body,
            data: {
              campaignId,
              ...((campaign.data as Record<string, unknown> | null) ?? {}),
            },
          });
          sent += 1;
        } catch (error) {
          failed += 1;
          this.logger.warn(`Campaign ${campaignId}: could not notify ${userId}: ${String(error)}`);
        }

        if ((index + 1) % PROGRESS_BATCH === 0) {
          await this.prisma.notificationCampaign.update({
            where: { id: campaignId },
            data: { sentCount: sent, failedCount: failed },
          });
        }
      }

      await this.prisma.notificationCampaign.update({
        where: { id: campaignId },
        data: {
          status: CampaignStatus.COMPLETED,
          sentCount: sent,
          failedCount: failed,
          completedAt: new Date(),
        },
      });

      this.logger.log(`Campaign ${campaignId}: ${sent} sent, ${failed} failed`);
    } catch (error) {
      // Record why it stopped rather than leaving an operator staring at a
      // send that is permanently "sending".
      await this.prisma.notificationCampaign.update({
        where: { id: campaignId },
        data: {
          status: CampaignStatus.FAILED,
          failureReason: String(error).slice(0, 500),
          completedAt: new Date(),
        },
      });

      throw error;
    }
  }

  async findCampaigns(query: AdminCampaignQueryDto): Promise<PaginatedResult<AdminCampaignDto>> {
    const where: Prisma.NotificationCampaignWhereInput = {
      ...(query.status?.length ? { status: { in: query.status } } : {}),
      ...(query.audience ? { audience: query.audience } : {}),
      ...(query.dateFrom || query.dateTo
        ? {
            createdAt: {
              ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
              ...(query.dateTo ? { lte: this.endOfDay(query.dateTo) } : {}),
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              { title: { contains: query.search, mode: 'insensitive' } },
              { body: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.notificationCampaign.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
        select: campaignSelect,
      }),
      this.prisma.notificationCampaign.count({ where }),
    ]);

    return PaginationUtil.paginate(rows.map((row) => this.toCampaign(row)), query.page, query.limit, total);
  }

  async findCampaign(id: string): Promise<AdminCampaignDto> {
    const campaign = await this.prisma.notificationCampaign.findUnique({
      where: { id },
      select: campaignSelect,
    });

    if (!campaign) throw AppException.notFound(ResponseCode.CAMPAIGN_NOT_FOUND);
    return this.toCampaign(campaign);
  }

  /**
   * Stops a campaign that has not gone out yet.
   *
   * A send already in flight cannot be recalled — the notifications written so
   * far are on people's phones — so this only refuses one still queued, and
   * says so plainly rather than pretending to undo anything.
   */
  async cancel(actorUserId: string, id: string): Promise<AdminCampaignDto> {
    const campaign = await this.findCampaign(id);

    const { count } = await this.prisma.notificationCampaign.updateMany({
      where: { id, status: CampaignStatus.QUEUED },
      data: { status: CampaignStatus.CANCELLED, completedAt: new Date() },
    });

    if (count === 0) {
      throw AppException.conflict(
        ResponseCode.CAMPAIGN_NOT_CANCELLABLE,
        campaign.status === CampaignStatus.SENDING
          ? 'This message is already going out and cannot be recalled.'
          : 'This message has already finished.',
      );
    }

    await this.queue.remove(campaignJobId(id)).catch(() => undefined);

    await this.audit.record({
      actorUserId,
      action: 'notification.cancel',
      entityType: 'NotificationCampaign',
      entityId: id,
      summary: `Cancelled "${campaign.title}" before it was sent`,
      before: { status: campaign.status },
      after: { status: CampaignStatus.CANCELLED },
    });

    return this.findCampaign(id);
  }

  /** Individual notifications, for answering "did this person get told?". */
  async findNotifications(
    query: AdminNotificationQueryDto,
  ): Promise<PaginatedResult<AdminNotificationRowDto>> {
    const where: Prisma.NotificationWhereInput = {
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.dateFrom || query.dateTo
        ? {
            createdAt: {
              ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
              ...(query.dateTo ? { lte: this.endOfDay(query.dateTo) } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
        select: {
          id: true,
          userId: true,
          type: true,
          title: true,
          body: true,
          readAt: true,
          createdAt: true,
          user: {
            select: {
              phone: true,
              customerProfile: { select: { fullName: true } },
              driverProfile: { select: { fullName: true } },
              adminProfile: { select: { fullName: true } },
            },
          },
          dispatches: { select: { status: true }, orderBy: { createdAt: 'desc' }, take: 1 },
        },
      }),
      this.prisma.notification.count({ where }),
    ]);

    return PaginationUtil.paginate(
      rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        recipientName:
          row.user.customerProfile?.fullName ??
          row.user.driverProfile?.fullName ??
          row.user.adminProfile?.fullName ??
          'Unknown',
        recipientPhone: row.user.phone,
        type: row.type,
        title: row.title,
        body: row.body,
        readAt: row.readAt?.toISOString() ?? null,
        // NONE, not FAILED: a recipient with no device registered was never
        // pushed to, which is different from a push that went wrong.
        pushStatus: row.dispatches[0]?.status ?? 'NONE',
        createdAt: row.createdAt.toISOString(),
      })),
      query.page,
      query.limit,
      total,
    );
  }

  // ── Audience resolution (also used by the worker) ──────────────────────

  /**
   * Who a campaign reaches, as user ids.
   *
   * Suspended and deleted accounts are always excluded: someone who cannot
   * sign in should not be sent to, and counting them would overstate the reach
   * on the preview.
   */
  async resolveAudience(dto: AdminAudienceDto): Promise<string[]> {
    switch (dto.audience) {
      case CampaignAudience.ALL_CUSTOMERS:
        return this.userIds({ role: UserRole.CUSTOMER });

      case CampaignAudience.ALL_DRIVERS:
        return this.userIds({ role: UserRole.DRIVER });

      case CampaignAudience.APPROVED_DRIVERS:
        return this.userIds({
          role: UserRole.DRIVER,
          driverProfile: { approvalStatus: DriverApprovalStatus.ACTIVE, deletedAt: null },
        });

      case CampaignAudience.DRIVERS_IN_ZONE:
        return this.userIds({
          role: UserRole.DRIVER,
          driverProfile: { deletedAt: null, zones: { some: { zoneId: dto.zoneId } } },
        });

      case CampaignAudience.ONLINE_DRIVERS:
        return this.onlineDriverUserIds();

      case CampaignAudience.SPECIFIC_USERS:
        return this.userIds({ id: { in: dto.userIds ?? [] } });

      default:
        return [];
    }
  }

  private async userIds(where: Prisma.UserWhereInput): Promise<string[]> {
    const users = await this.prisma.user.findMany({
      where: { ...where, status: UserStatus.ACTIVE, deletedAt: null },
      select: { id: true },
    });

    return users.map((user) => user.id);
  }

  /** Drivers the matcher can see right now, mapped back to their accounts. */
  private async onlineDriverUserIds(): Promise<string[]> {
    const vehicleTypes = await this.prisma.vehicleType.findMany({
      where: { isActive: true },
      select: { code: true },
    });

    const online = await this.presence.onlineDriverIds(vehicleTypes.map((type) => type.code));
    if (online.length === 0) return [];

    const drivers = await this.prisma.driverProfile.findMany({
      where: {
        id: { in: online },
        deletedAt: null,
        user: { status: UserStatus.ACTIVE, deletedAt: null },
      },
      select: { userId: true },
    });

    return drivers.map((driver) => driver.userId);
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async assertAudienceValid(dto: AdminSendNotificationDto): Promise<void> {
    if (dto.audience === CampaignAudience.DRIVERS_IN_ZONE) {
      const zone = await this.prisma.zone.findFirst({
        where: { id: dto.zoneId, deletedAt: null },
        select: { id: true },
      });
      if (!zone) throw AppException.notFound(ResponseCode.ZONE_NOT_FOUND);
    }

    if (dto.audience === CampaignAudience.SPECIFIC_USERS) {
      const found = await this.prisma.user.count({
        where: { id: { in: dto.userIds ?? [] }, deletedAt: null },
      });
      if (found !== new Set(dto.userIds).size) {
        throw AppException.unprocessable(
          ResponseCode.ACCOUNT_NOT_FOUND,
          'One or more of those accounts do not exist.',
        );
      }
    }
  }

  private filtersFor(dto: AdminSendNotificationDto): Prisma.InputJsonValue | undefined {
    if (dto.audience === CampaignAudience.DRIVERS_IN_ZONE) return { zoneId: dto.zoneId as string };
    if (dto.audience === CampaignAudience.SPECIFIC_USERS) return { userIds: dto.userIds ?? [] };
    return undefined;
  }

  private toCampaign(
    row: Prisma.NotificationCampaignGetPayload<{ select: typeof campaignSelect }>,
  ): AdminCampaignDto {
    return {
      id: row.id,
      title: row.title,
      body: row.body,
      type: row.type,
      audience: row.audience,
      filters: (row.filters as Record<string, unknown> | null) ?? null,
      status: row.status,
      totalRecipients: row.totalRecipients,
      sentCount: row.sentCount,
      failedCount: row.failedCount,
      failureReason: row.failureReason,
      createdByName: row.createdBy.adminProfile?.fullName ?? 'System',
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private endOfDay(date: string): Date {
    const parsed = new Date(date);
    parsed.setUTCHours(23, 59, 59, 999);
    return parsed;
  }
}

