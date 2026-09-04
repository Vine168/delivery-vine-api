import { Injectable, Logger } from '@nestjs/common';
import { WsEvent } from '../../common/constants/events.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import { PaginationUtil } from '../../common/utils/pagination.util.js';
import type { CursorPaginatedResult } from '../../common/interfaces/paginated.interface.js';
import { PrismaService } from '../../database/prisma.service.js';
import { RealtimeEmitter } from '../../gateway/realtime.emitter.js';
import { FilePurpose, MessageType } from '../../generated/prisma/enums.js';
import { FileUrlService } from '../uploads/file-url.service.js';
import { UploadsService } from '../uploads/uploads.service.js';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface.js';
import type { ConversationDto, MessageDto, MessageQueryDto, SendMessageDto } from './dto/chat.dto.js';

/** How long after a delivery ends the two parties can still write to each other. */
const CLOSE_AFTER_HOURS = 24;

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fileUrls: FileUrlService,
    private readonly uploads: UploadsService,
    private readonly realtime: RealtimeEmitter,
  ) {}

  /**
   * Opens the conversation for a delivery once a driver is assigned.
   *
   * Created here rather than on the first message so both apps can show a chat
   * button immediately, and so participants are recorded while the delivery
   * still knows who they are.
   */
  async openForDelivery(deliveryId: string): Promise<void> {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      select: {
        id: true,
        customerId: true,
        driverId: true,
        customer: { select: { userId: true } },
        driver: { select: { userId: true } },
      },
    });

    if (!delivery?.driverId || !delivery.driver) return;

    const existing = await this.prisma.conversation.findUnique({
      where: { deliveryId },
      select: { id: true, driverId: true },
    });

    if (existing) {
      // A re-assigned delivery keeps its thread but changes who is in it.
      if (existing.driverId !== delivery.driverId) {
        await this.prisma.conversation.update({
          where: { id: existing.id },
          data: {
            driverId: delivery.driverId,
            participants: {
              deleteMany: {},
              create: [{ userId: delivery.customer.userId }, { userId: delivery.driver.userId }],
            },
          },
        });
      }
      return;
    }

    await this.prisma.conversation.create({
      data: {
        deliveryId,
        customerId: delivery.customerId,
        driverId: delivery.driverId,
        participants: {
          create: [{ userId: delivery.customer.userId }, { userId: delivery.driver.userId }],
        },
      },
    });
  }

  /** Stops new messages once a delivery has been finished long enough. */
  async closeForDelivery(deliveryId: string): Promise<void> {
    await this.prisma.conversation.updateMany({
      where: { deliveryId, closedAt: null },
      data: { closedAt: new Date(Date.now() + CLOSE_AFTER_HOURS * 3_600_000) },
    });
  }

  async findAll(user: AuthenticatedUser): Promise<ConversationDto[]> {
    const conversations = await this.prisma.conversation.findMany({
      where: { participants: { some: { userId: user.userId } } },
      orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
      take: 50,
      select: {
        id: true,
        deliveryId: true,
        lastMessageAt: true,
        closedAt: true,
        delivery: { select: { bookingCode: true } },
        customer: { select: { fullName: true, avatarFileId: true, userId: true } },
        driver: { select: { fullName: true, avatarFileId: true, userId: true } },
        participants: { where: { userId: user.userId }, select: { lastReadAt: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { body: true, type: true } },
      },
    });

    const counterparts = conversations.map((row) =>
      row.customer.userId === user.userId ? row.driver : row.customer,
    );
    const avatarUrls = await this.fileUrls.resolveMany(counterparts.map((party) => party?.avatarFileId));

    const unreadCounts = await Promise.all(
      conversations.map((row) =>
        this.prisma.message.count({
          where: {
            conversationId: row.id,
            senderUserId: { not: user.userId },
            deletedAt: null,
            ...(row.participants[0]?.lastReadAt ? { createdAt: { gt: row.participants[0].lastReadAt } } : {}),
          },
        }),
      ),
    );

    return conversations.map((row, index) => {
      const counterpart = counterparts[index];
      const preview = row.messages[0];

      return {
        id: row.id,
        deliveryId: row.deliveryId,
        bookingCode: row.delivery.bookingCode,
        counterpartName: counterpart?.fullName ?? 'Deliver',
        counterpartAvatarUrl: counterpart?.avatarFileId
          ? (avatarUrls.get(counterpart.avatarFileId) ?? null)
          : null,
        lastMessage: preview ? (preview.type === MessageType.TEXT ? preview.body : `[${preview.type.toLowerCase()}]`) : null,
        lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
        unreadCount: unreadCounts[index],
        closed: this.isClosed(row.closedAt),
      };
    });
  }

  /**
   * Reads a thread, newest first, and marks it read.
   *
   * Cursor paginated because a chat only grows, and an offset page would drift
   * as new messages arrive while the customer scrolls.
   */
  async findMessages(
    user: AuthenticatedUser,
    conversationId: string,
    query: MessageQueryDto,
  ): Promise<CursorPaginatedResult<MessageDto>> {
    await this.assertParticipant(user, conversationId);

    const rows = await this.prisma.message.findMany({
      where: { conversationId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        conversationId: true,
        type: true,
        body: true,
        fileId: true,
        latitude: true,
        longitude: true,
        senderUserId: true,
        createdAt: true,
        sender: {
          select: {
            customerProfile: { select: { fullName: true } },
            driverProfile: { select: { fullName: true } },
          },
        },
      },
    });

    const page = PaginationUtil.cursorPage(rows, query.limit);
    const fileUrls = await this.fileUrls.resolveMany(page.items.map((message) => message.fileId));

    await this.prisma.conversationParticipant.updateMany({
      where: { conversationId, userId: user.userId },
      data: { lastReadAt: new Date() },
    });

    return {
      items: page.items.map((message) => this.toDto(message, user.userId, fileUrls)),
      meta: page.meta,
    };
  }

  async send(user: AuthenticatedUser, conversationId: string, dto: SendMessageDto): Promise<MessageDto> {
    const conversation = await this.assertParticipant(user, conversationId);

    if (this.isClosed(conversation.closedAt)) {
      throw AppException.unprocessable(
        ResponseCode.CONVERSATION_CLOSED,
        'This conversation is closed. Contact support if you still need help.',
      );
    }

    if (dto.type === MessageType.IMAGE && dto.fileId) {
      await this.uploads.assertOwnedForPurpose(dto.fileId, user.userId, [FilePurpose.CHAT_ATTACHMENT]);
    }

    const message = await this.prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          conversationId,
          senderUserId: user.userId,
          type: dto.type,
          body: dto.body,
          fileId: dto.fileId,
          latitude: dto.latitude,
          longitude: dto.longitude,
        },
        select: {
          id: true,
          conversationId: true,
          type: true,
          body: true,
          fileId: true,
          latitude: true,
          longitude: true,
          senderUserId: true,
          createdAt: true,
          sender: {
            select: {
              customerProfile: { select: { fullName: true } },
              driverProfile: { select: { fullName: true } },
            },
          },
        },
      });

      await tx.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: created.createdAt },
      });

      return created;
    });

    const fileUrls = await this.fileUrls.resolveMany([message.fileId]);
    const dtoOut = this.toDto(message, user.userId, fileUrls);

    // Pushed to the other participant's own room, so they receive it wherever
    // they are in the app rather than only on the chat screen.
    for (const participant of conversation.participants) {
      if (participant.userId === user.userId) continue;
      this.realtime.toUser(participant.userId, WsEvent.CHAT_MESSAGE_CREATED, {
        ...dtoOut,
        mine: false,
      });
    }

    this.realtime.toConversation(conversationId, WsEvent.CHAT_MESSAGE_CREATED, dtoOut);

    return dtoOut;
  }

  private async assertParticipant(user: AuthenticatedUser, conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, participants: { some: { userId: user.userId } } },
      select: { id: true, closedAt: true, participants: { select: { userId: true } } },
    });

    if (!conversation) {
      // Same answer whether it does not exist or belongs to other people.
      throw AppException.notFound(ResponseCode.CONVERSATION_NOT_FOUND);
    }

    return conversation;
  }

  private isClosed(closedAt: Date | null): boolean {
    return closedAt !== null && closedAt.getTime() <= Date.now();
  }

  private toDto(
    message: {
      id: string;
      conversationId: string;
      type: MessageType;
      body: string | null;
      fileId: string | null;
      latitude: number | null;
      longitude: number | null;
      senderUserId: string;
      createdAt: Date;
      sender: {
        customerProfile: { fullName: string } | null;
        driverProfile: { fullName: string } | null;
      };
    },
    viewerUserId: string,
    fileUrls: Map<string, string>,
  ): MessageDto {
    return {
      id: message.id,
      conversationId: message.conversationId,
      type: message.type,
      body: message.body,
      fileUrl: message.fileId ? (fileUrls.get(message.fileId) ?? null) : null,
      latitude: message.latitude,
      longitude: message.longitude,
      senderName:
        message.sender.customerProfile?.fullName ?? message.sender.driverProfile?.fullName ?? 'Deliver',
      mine: message.senderUserId === viewerUserId,
      createdAt: message.createdAt.toISOString(),
    };
  }
}
