import { Logger, type OnApplicationShutdown, UseFilters, UsePipes } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type WsResponse,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { ConfigService } from '@nestjs/config';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Redis } from 'ioredis';
import type { Server, Socket } from 'socket.io';
import { WsEvent, WsRoom } from '../common/constants/events.js';
import { VALIDATION_PIPE_OPTIONS } from '../common/pipes/validation.pipe.js';
import { ValidationPipe } from '@nestjs/common';
import type { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface.js';
import { PrismaService } from '../database/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { DeliveryStatus } from '../generated/prisma/enums.js';
import { DriverAvailabilityService } from '../modules/driver-presence/driver-availability.service.js';
import { RealtimeEmitter } from './realtime.emitter.js';
import { SocketLocationDto, SubscribeDeliveryDto } from './dto/realtime.dto.js';
import { WsExceptionFilter } from './ws-exception.filter.js';
import { WsAuthService } from './ws-auth.service.js';

interface SocketData {
  user: AuthenticatedUser;
}

type AppSocket = Socket & { data: SocketData };

/**
 * One socket per app.
 *
 * Mobile clients open a single connection and join rooms, rather than one
 * connection per feature: a phone on a patchy network should maintain one
 * link, not three. Separation of concerns lives in the emitter and the
 * listener instead of in extra namespaces.
 *
 * Membership of a delivery room is decided by the server after checking the
 * database. A client cannot join a room by asking nicely.
 */
@UseFilters(WsExceptionFilter)
@WebSocketGateway({
  cors: { origin: true, credentials: true },
  // Mobile networks drop; give clients room to reconnect before we forget them.
  pingInterval: 25_000,
  pingTimeout: 20_000,
})
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnApplicationShutdown {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  private server: Server;

  private adapterClients: Redis[] = [];

  constructor(
    private readonly auth: WsAuthService,
    private readonly emitter: RealtimeEmitter,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly availability: DriverAvailabilityService,
    private readonly config: ConfigService,
  ) {}

  async afterInit(server: Server): Promise<void> {
    // Without the Redis adapter an event emitted on one API instance never
    // reaches a client connected to another.
    // Unmanaged: this gateway closes them itself, after the socket server.
    const pub = this.redis.duplicate({ keyPrefix: undefined }, { managed: false });
    const sub = this.redis.duplicate({ keyPrefix: undefined }, { managed: false });
    this.adapterClients = [pub, sub];

    // The adapter issues commands of its own; without these handlers a socket
    // torn down during shutdown surfaces as an unhandled rejection.
    for (const client of [pub, sub]) {
      client.on('error', (error: Error) => this.logger.warn(`Socket adapter Redis: ${error.message}`));
    }

    try {
      await Promise.all([pub.connect(), sub.connect()]);
      server.adapter(
        createAdapter(pub, sub, { key: `${this.config.get<string>('redis.keyPrefix', 'deliver:')}ws` }),
      );
      this.logger.log('Realtime gateway ready (Redis adapter attached)');
    } catch (error) {
      // A single instance still works without the adapter; a fleet would not
      // share events, so this is worth shouting about.
      this.logger.error(`Realtime running WITHOUT the Redis adapter: ${String(error)}`);
    }

    this.server = server;
    this.emitter.attach(server);
  }

  /**
   * Closed here, not in onModuleDestroy.
   *
   * Nest disposes the Socket.IO adapter after module teardown, and the Redis
   * adapter unsubscribes on the way out. Quitting these connections any
   * earlier leaves that unsubscribe talking to a closed socket.
   */
  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled(this.adapterClients.map((client) => client.quit()));
    this.adapterClients = [];
  }

  async handleConnection(socket: AppSocket): Promise<void> {
    const user = await this.auth.authenticate(socket);

    if (!user) {
      socket.emit(WsEvent.CONNECTION_ERROR, { code: 'UNAUTHORIZED', message: 'A valid access token is required.' });
      socket.disconnect(true);
      return;
    }

    socket.data.user = user;

    const rooms = [WsRoom.user(user.userId)];
    if (user.driverId) rooms.push(WsRoom.driver(user.driverId));

    await socket.join(rooms);

    // Rejoin the delivery a driver is already working, so a reconnect does not
    // leave them silent mid-job.
    const activeRooms = await this.activeDeliveryRooms(user);
    if (activeRooms.length > 0) {
      await socket.join(activeRooms);
      rooms.push(...activeRooms);
    }

    socket.emit(WsEvent.CONNECTION_READY, {
      userId: user.userId,
      rooms,
      serverTime: new Date().toISOString(),
    });

    this.logger.debug(`Socket ${socket.id} connected as ${user.userId} (${user.role})`);
  }

  handleDisconnect(socket: AppSocket): void {
    this.logger.debug(`Socket ${socket.id} disconnected`);
  }

  /**
   * Joins a delivery room after confirming the caller is actually part of it.
   * This is the check that stops anyone watching a stranger's delivery.
   */
  @SubscribeMessage(WsEvent.CLIENT_SUBSCRIBE_DELIVERY)
  @UsePipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS))
  async subscribeDelivery(
    @ConnectedSocket() socket: AppSocket,
    @MessageBody() body: SubscribeDeliveryDto,
  ): Promise<WsResponse<{ deliveryId: string; subscribed: boolean; room?: string; code?: string }>> {
    const user = socket.data.user;

    const delivery = await this.prisma.delivery.findFirst({
      where: {
        id: body.deliveryId,
        deletedAt: null,
        OR: [
          ...(user.customerId ? [{ customerId: user.customerId }] : []),
          ...(user.driverId ? [{ driverId: user.driverId }] : []),
        ],
      },
      select: { id: true },
    });

    if (!delivery) {
      return {
        event: WsEvent.DELIVERY_SUBSCRIBED,
        data: { deliveryId: body.deliveryId, subscribed: false, code: 'DELIVERY_NOT_FOUND' },
      };
    }

    const room = WsRoom.delivery(delivery.id);
    await socket.join(room);

    return {
      event: WsEvent.DELIVERY_SUBSCRIBED,
      data: { deliveryId: delivery.id, subscribed: true, room },
    };
  }

  @SubscribeMessage(WsEvent.CLIENT_UNSUBSCRIBE_DELIVERY)
  @UsePipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS))
  async unsubscribeDelivery(
    @ConnectedSocket() socket: AppSocket,
    @MessageBody() body: SubscribeDeliveryDto,
  ): Promise<WsResponse<{ deliveryId: string; subscribed: boolean }>> {
    await socket.leave(WsRoom.delivery(body.deliveryId));

    return {
      event: WsEvent.DELIVERY_UNSUBSCRIBED,
      data: { deliveryId: body.deliveryId, subscribed: false },
    };
  }

  /**
   * Position over the socket instead of an HTTP request.
   *
   * A driver pings every few seconds for an entire shift; reusing the open
   * connection avoids a TLS handshake and a round of headers each time. It
   * runs the same service as PUT /mobile/driver/location, so the rules — must
   * be online, throttled persistence, automatic IN_TRANSIT — are identical.
   */
  @SubscribeMessage(WsEvent.CLIENT_DRIVER_LOCATION)
  @UsePipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS))
  async pushLocation(
    @ConnectedSocket() socket: AppSocket,
    @MessageBody() body: SocketLocationDto,
  ): Promise<WsResponse<{ accepted: boolean; code?: string }>> {
    const user = socket.data.user;
    const reply = (data: { accepted: boolean; code?: string }): WsResponse<typeof data> => ({
      event: WsEvent.DRIVER_LOCATION_ACCEPTED,
      data,
    });

    if (!user.driverId) {
      return reply({ accepted: false, code: 'ROLE_NOT_ALLOWED' });
    }

    try {
      await this.availability.updateLocation(user.driverId, body);
      return reply({ accepted: true });
    } catch (error) {
      // A rejected fix must not kill the socket — the driver may simply have
      // gone offline in another tab.
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code: unknown }).code)
          : 'INTERNAL_ERROR';

      return reply({ accepted: false, code });
    }
  }

  /** The delivery rooms a reconnecting client should be put back into. */
  private async activeDeliveryRooms(user: AuthenticatedUser): Promise<string[]> {
    const active = await this.prisma.delivery.findMany({
      where: {
        deletedAt: null,
        status: {
          in: [
            DeliveryStatus.SEARCHING_DRIVER,
            DeliveryStatus.DRIVER_ASSIGNED,
            DeliveryStatus.ARRIVED_PICKUP,
            DeliveryStatus.PICKED_UP,
            DeliveryStatus.IN_TRANSIT,
            DeliveryStatus.ARRIVED_DROPOFF,
          ],
        },
        ...(user.driverId ? { driverId: user.driverId } : { customerId: user.customerId }),
      },
      select: { id: true },
      take: 10,
    });

    return active.map((delivery) => WsRoom.delivery(delivery.id));
  }
}
