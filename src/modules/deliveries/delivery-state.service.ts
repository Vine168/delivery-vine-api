import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DomainEvent } from '../../common/constants/events.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { ActorType, DeliveryStatus } from '../../generated/prisma/enums.js';
import { STATUS_TIMESTAMP_FIELD, actorCanTransition, canTransition } from './delivery-state.policy.js';

export type TransactionClient = Prisma.TransactionClient;

export interface TransitionInput {
  deliveryId: string;
  to: DeliveryStatus;
  actorType: ActorType;
  actorUserId?: string;
  /** Restrict the update to these current statuses. Defaults to any status that legally leads to `to`. */
  expectedFrom?: DeliveryStatus[];
  reason?: string;
  metadata?: Prisma.InputJsonValue;
  /** Extra columns to set in the same statement, e.g. driverId on assignment. */
  data?: Prisma.DeliveryUncheckedUpdateManyInput;
  /**
   * Extra conditions the row must still satisfy. Job acceptance uses
   * `{ driverId: null }` so a second driver's update matches nothing.
   */
  where?: Prisma.DeliveryWhereInput;
  /** The code to report when the conditional update matches no rows. */
  conflictCode?: ResponseCode;
}

export interface TransitionResult {
  deliveryId: string;
  from: DeliveryStatus;
  to: DeliveryStatus;
  bookingCode: string;
  customerId: string;
  driverId: string | null;
  /** When the change was written. Matching uses it to tell one search attempt from the next. */
  at: Date;
}

/**
 * The only writer of `Delivery.status`.
 *
 * A transition is one conditional UPDATE plus one history row, in the caller's
 * transaction. Because the UPDATE names the statuses it will accept, two
 * concurrent requests cannot both move the same delivery: the second matches
 * zero rows and is told so, rather than silently overwriting the first.
 */
@Injectable()
export class DeliveryStateService {
  private readonly logger = new Logger(DeliveryStateService.name);

  constructor(private readonly events: EventEmitter2) {}

  async transition(tx: TransactionClient, input: TransitionInput): Promise<TransitionResult> {
    const delivery = await tx.delivery.findUnique({
      where: { id: input.deliveryId },
      select: { id: true, status: true, bookingCode: true, customerId: true, driverId: true },
    });

    if (!delivery) {
      throw AppException.notFound(ResponseCode.DELIVERY_NOT_FOUND);
    }

    const from = delivery.status;

    if (!canTransition(from, input.to)) {
      throw AppException.unprocessable(
        ResponseCode.DELIVERY_INVALID_TRANSITION,
        `A delivery that is ${this.humanise(from)} cannot become ${this.humanise(input.to)}.`,
      );
    }

    if (!actorCanTransition(from, input.to, input.actorType)) {
      throw AppException.forbidden(
        ResponseCode.DELIVERY_INVALID_TRANSITION,
        `You cannot change this delivery from ${this.humanise(from)} to ${this.humanise(input.to)}.`,
      );
    }

    const acceptedFrom = input.expectedFrom ?? [from];
    const timestampField = STATUS_TIMESTAMP_FIELD[input.to];
    const at = new Date();

    const { count } = await tx.delivery.updateMany({
      where: { id: input.deliveryId, status: { in: acceptedFrom }, ...input.where },
      data: {
        status: input.to,
        ...(timestampField ? { [timestampField]: at } : {}),
        ...input.data,
      },
    });

    // Someone else moved it between our read and our write. This is the line
    // that makes two drivers accepting the same job safe: the loser's UPDATE
    // matches zero rows and it is told so, rather than overwriting the winner.
    if (count === 0) {
      throw AppException.conflict(
        input.conflictCode ?? ResponseCode.DELIVERY_INVALID_TRANSITION,
        input.conflictCode ? undefined : 'This delivery was updated by someone else. Please refresh.',
      );
    }

    await tx.deliveryStatusHistory.create({
      data: {
        deliveryId: input.deliveryId,
        fromStatus: from,
        toStatus: input.to,
        actorType: input.actorType,
        actorUserId: input.actorUserId,
        reason: input.reason,
        metadata: input.metadata,
      },
    });

    return {
      deliveryId: delivery.id,
      from,
      to: input.to,
      bookingCode: delivery.bookingCode,
      customerId: delivery.customerId,
      driverId: delivery.driverId,
      at,
    };
  }

  /**
   * Announces a completed transition after the transaction commits.
   *
   * Emitting inside the transaction would tell the world about a change that
   * might still roll back, so callers do this once they are committed.
   *
   * Awaited rather than fired and forgotten: a completed delivery pays the
   * driver, and the response should not claim success while the money is still
   * in flight. Listeners are expected to swallow their own failures — none of
   * them may undo a transition that has already committed.
   */
  async publish(result: TransitionResult): Promise<void> {
    await this.events.emitAsync(DomainEvent.DELIVERY_STATUS_CHANGED, result);

    const specific: Partial<Record<DeliveryStatus, string>> = {
      [DeliveryStatus.DRIVER_ASSIGNED]: DomainEvent.DELIVERY_ASSIGNED,
      [DeliveryStatus.DELIVERED]: DomainEvent.DELIVERY_COMPLETED,
      [DeliveryStatus.CANCELLED]: DomainEvent.DELIVERY_CANCELLED,
      [DeliveryStatus.EXPIRED]: DomainEvent.DELIVERY_EXPIRED,
      [DeliveryStatus.SEARCHING_DRIVER]: DomainEvent.DELIVERY_CONFIRMED,
    };

    const event = specific[result.to];
    if (event) {
      await this.events.emitAsync(event, result);
    }

    this.logger.log(`${result.bookingCode}: ${result.from} → ${result.to}`);
  }

  private humanise(status: DeliveryStatus): string {
    return status.toLowerCase().replaceAll('_', ' ');
  }
}
