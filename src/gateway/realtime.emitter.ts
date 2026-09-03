import { Injectable, Logger } from '@nestjs/common';
import type { Server } from 'socket.io';
import { WsEvent, WsRoom } from '../common/constants/events.js';

/**
 * The only place that pushes to sockets.
 *
 * Holding the Server here rather than in the gateway means any module can
 * broadcast without importing the gateway (and without the circular
 * dependency that would create). If no socket server is attached — a worker
 * process, a test that does not need one — emitting is a no-op rather than a
 * crash.
 */
@Injectable()
export class RealtimeEmitter {
  private readonly logger = new Logger(RealtimeEmitter.name);
  private server: Server | null = null;

  attach(server: Server): void {
    this.server = server;
  }

  get isAttached(): boolean {
    return this.server !== null;
  }

  toUser(userId: string, event: string, payload: unknown): void {
    this.emit(WsRoom.user(userId), event, payload);
  }

  toDriver(driverId: string, event: string, payload: unknown): void {
    this.emit(WsRoom.driver(driverId), event, payload);
  }

  toDelivery(deliveryId: string, event: string, payload: unknown): void {
    this.emit(WsRoom.delivery(deliveryId), event, payload);
  }

  toConversation(conversationId: string, event: string, payload: unknown): void {
    this.emit(WsRoom.conversation(conversationId), event, payload);
  }

  /** Everyone watching a delivery, plus the customer wherever they are in the app. */
  toDeliveryParticipants(
    deliveryId: string,
    customerUserId: string | null,
    event: string,
    payload: unknown,
  ): void {
    this.toDelivery(deliveryId, event, payload);
    if (customerUserId) {
      this.toUser(customerUserId, event, payload);
    }
  }

  /** How many sockets are currently in a room — used by tests and diagnostics. */
  async roomSize(room: string): Promise<number> {
    if (!this.server) return 0;
    const sockets = await this.server.in(room).fetchSockets();
    return sockets.length;
  }

  private emit(room: string, event: string, payload: unknown): void {
    if (!this.server) {
      this.logger.debug(`No socket server attached; dropped ${event} for ${room}`);
      return;
    }

    this.server.to(room).emit(event, payload);
  }
}

export { WsEvent, WsRoom };
