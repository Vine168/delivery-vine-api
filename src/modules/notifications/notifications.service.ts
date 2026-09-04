import { Inject, Injectable, Logger } from '@nestjs/common';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import { PaginationUtil } from '../../common/utils/pagination.util.js';
import type { PaginatedResult } from '../../common/interfaces/paginated.interface.js';
import { PrismaService } from '../../database/prisma.service.js';
import { RealtimeEmitter } from '../../gateway/realtime.emitter.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { NotificationType, PushDispatchStatus } from '../../generated/prisma/enums.js';
import { PUSH_SENDER, type PushSender } from './push-sender.interface.js';
import type {
  ListNotificationsQueryDto,
  NotificationDto,
  RegisterDeviceDto,
  UnreadCountDto,
} from './dto/notification.dto.js';

export interface CreateNotificationInput {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Prisma.InputJsonValue;
  deliveryId?: string;
}

/** Sent to an open app the instant the notification is written. */
const NOTIFICATION_EVENT = 'notification.created';

/**
 * In-app notifications, and the push attempts that carry them.
 *
 * The record and its delivery are deliberately separate: the notification is
 * written first and always, and a push that fails leaves a PushDispatch row
 * explaining why rather than losing the message. A dead Firebase token can
 * never cost a customer their delivery update.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeEmitter,
    @Inject(PUSH_SENDER) private readonly push: PushSender,
  ) {}

  async create(input: CreateNotificationInput): Promise<void> {
    const notification = await this.prisma.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body,
        data: input.data,
        deliveryId: input.deliveryId,
      },
      select: { id: true, type: true, title: true, body: true, data: true, deliveryId: true, createdAt: true },
    });

    // Straight to the app if it is open…
    this.realtime.toUser(input.userId, NOTIFICATION_EVENT, {
      ...notification,
      read: false,
      createdAt: notification.createdAt.toISOString(),
    });

    // …and to the phone if it is not.
    await this.dispatch(notification.id, input);
  }

  /** Sends to every live token the user has, recording each attempt. */
  private async dispatch(notificationId: string, input: CreateNotificationInput): Promise<void> {
    const tokens = await this.prisma.devicePushToken.findMany({
      where: { isActive: true, device: { userId: input.userId } },
      select: { id: true, token: true, provider: true },
    });

    for (const token of tokens) {
      const result = await this.push.send({
        token: token.token,
        title: input.title,
        body: input.body,
        data: {
          type: input.type,
          ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
        },
      });

      await this.prisma.pushDispatch.create({
        data: {
          notificationId,
          pushTokenId: token.id,
          provider: token.provider,
          // SKIPPED, not FAILED, when push simply is not set up — the
          // difference matters when reading these rows later.
          status: result.delivered
            ? PushDispatchStatus.SENT
            : this.push.isConfigured()
              ? PushDispatchStatus.FAILED
              : PushDispatchStatus.SKIPPED,
          providerRef: result.providerRef,
          error: result.error,
          attempts: 1,
          sentAt: result.delivered ? new Date() : null,
        },
      });

      // A token the provider rejects is dead; stop using it.
      if (result.tokenInvalid) {
        await this.prisma.devicePushToken.update({ where: { id: token.id }, data: { isActive: false } });
      }
    }
  }

  async findAll(userId: string, query: ListNotificationsQueryDto): Promise<PaginatedResult<NotificationDto>> {
    const where = { userId, ...(query.unreadOnly ? { readAt: null } : {}) };

    const [rows, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
        select: {
          id: true,
          type: true,
          title: true,
          body: true,
          data: true,
          deliveryId: true,
          readAt: true,
          createdAt: true,
        },
      }),
      this.prisma.notification.count({ where }),
    ]);

    return PaginationUtil.paginate(
      rows.map((row) => ({
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        data: (row.data as Record<string, unknown> | null) ?? null,
        deliveryId: row.deliveryId,
        read: row.readAt !== null,
        createdAt: row.createdAt.toISOString(),
      })),
      query.page,
      query.limit,
      total,
    );
  }

  async unreadCount(userId: string): Promise<UnreadCountDto> {
    return { unread: await this.prisma.notification.count({ where: { userId, readAt: null } }) };
  }

  async markRead(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });

    if (count > 0) return;

    // Nothing updated: either it is not theirs, or it was already read.
    const exists = await this.prisma.notification.count({ where: { id, userId } });
    if (exists === 0) {
      throw AppException.notFound(ResponseCode.NOTIFICATION_NOT_FOUND);
    }
  }

  async markAllRead(userId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
  }

  /**
   * Registers this installation's push token.
   *
   * A token can move between accounts — a shared phone, or a driver who also
   * orders deliveries — so it is claimed by whoever registered it last rather
   * than duplicated across users.
   */
  async registerDevice(userId: string, dto: RegisterDeviceDto): Promise<void> {
    const device = await this.prisma.device.upsert({
      where: { userId_installationId: { userId, installationId: dto.installationId } },
      create: {
        userId,
        installationId: dto.installationId,
        platform: dto.platform,
        appVersion: dto.appVersion,
        locale: dto.locale,
      },
      update: {
        platform: dto.platform,
        appVersion: dto.appVersion,
        locale: dto.locale,
        lastSeenAt: new Date(),
      },
      select: { id: true },
    });

    await this.prisma.devicePushToken.upsert({
      where: { token: dto.pushToken },
      create: { deviceId: device.id, token: dto.pushToken, provider: dto.provider },
      update: { deviceId: device.id, provider: dto.provider, isActive: true, lastUsedAt: new Date() },
    });
  }

  /** Called on sign-out, so a shared phone stops receiving the previous user's alerts. */
  async unregisterDevice(userId: string, installationId: string): Promise<void> {
    const device = await this.prisma.device.findUnique({
      where: { userId_installationId: { userId, installationId } },
      select: { id: true },
    });

    if (!device) return;

    await this.prisma.devicePushToken.updateMany({
      where: { deviceId: device.id },
      data: { isActive: false },
    });
  }
}
