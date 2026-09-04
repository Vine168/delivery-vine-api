import { Injectable, Logger } from '@nestjs/common';
import { ResponseCode } from '../../../common/constants/response-codes.js';
import { AppException } from '../../../common/exceptions/app.exception.js';
import type { PaginatedResult } from '../../../common/interfaces/paginated.interface.js';
import { PaginationUtil } from '../../../common/utils/pagination.util.js';
import { PrismaService } from '../../../database/prisma.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { PaymentStatus, RefundStatus } from '../../../generated/prisma/enums.js';
import { AuditService } from '../audit.service.js';
import type {
  AdminRefundDto,
  AdminRefundQueryDto,
  AdminRequestRefundDto,
  AdminSettleRefundDto,
} from '../dto/admin-refund.dto.js';
import type { AdminReasonDto } from '../dto/admin-driver.dto.js';

const refundSelect = {
  id: true,
  paymentId: true,
  deliveryId: true,
  amount: true,
  currency: true,
  status: true,
  reason: true,
  providerRef: true,
  failureReason: true,
  requestedAt: true,
  settledAt: true,
  delivery: { select: { bookingCode: true, customer: { select: { fullName: true } } } },
  payment: { select: { method: true, provider: true, amount: true } },
  requestedBy: { select: { adminProfile: { select: { fullName: true } } } },
  settledBy: { select: { adminProfile: { select: { fullName: true } } } },
} as const;

/**
 * Money going back to a customer.
 *
 * Recording a refund does not move any money — the payment provider does, in
 * its own dashboard or through its own API — so this is deliberately the same
 * two-step the platform uses for payouts. An operator records what is owed,
 * and someone records afterwards that it actually went, with the provider's
 * reference to prove it. A refund is never marked settled because a button was
 * pressed.
 *
 * Cash bookings are refused outright rather than fudged: the platform never
 * received that money, the driver was handed it at the door, and pretending
 * otherwise would put a refund in the books against a payment that does not
 * exist.
 */
@Injectable()
export class AdminRefundsService {
  private readonly logger = new Logger(AdminRefundsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findAll(query: AdminRefundQueryDto): Promise<PaginatedResult<AdminRefundDto>> {
    const where: Prisma.RefundWhereInput = {
      ...(query.status?.length ? { status: { in: query.status } } : {}),
      ...(query.deliveryId ? { deliveryId: query.deliveryId } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.refund.findMany({
        where,
        // Oldest first: a customer waiting on their money should not queue
        // behind one who asked this morning.
        orderBy: { requestedAt: 'asc' },
        skip: query.skip,
        take: query.limit,
        select: refundSelect,
      }),
      this.prisma.refund.count({ where }),
    ]);

    return PaginationUtil.paginate(rows.map((row) => this.toRefund(row)), query.page, query.limit, total);
  }

  async findOne(id: string): Promise<AdminRefundDto> {
    const refund = await this.prisma.refund.findUnique({ where: { id }, select: refundSelect });
    if (!refund) throw AppException.notFound(ResponseCode.REFUND_NOT_FOUND);
    return this.toRefund(refund);
  }

  /**
   * Records that a customer is owed money back.
   *
   * Refuses to promise more than was actually taken, counting refunds already
   * in flight — otherwise two operators working the same complaint could each
   * approve a full refund and the platform would pay twice.
   */
  async request(
    actorUserId: string,
    deliveryId: string,
    dto: AdminRequestRefundDto,
  ): Promise<AdminRefundDto> {
    const payment = await this.prisma.payment.findFirst({
      where: { deliveryId, status: PaymentStatus.PAID },
      orderBy: { paidAt: 'desc' },
      select: {
        id: true,
        amount: true,
        currency: true,
        delivery: { select: { bookingCode: true } },
      },
    });

    if (!payment) {
      throw AppException.unprocessable(
        ResponseCode.PAYMENT_NOT_REFUNDABLE,
        'This delivery has no settled online payment. A cash fare was never held by the platform, so there is nothing here to send back.',
      );
    }

    const committed = await this.prisma.refund.aggregate({
      where: { paymentId: payment.id, status: { in: [RefundStatus.PENDING, RefundStatus.SETTLED] } },
      _sum: { amount: true },
    });

    const alreadyCommitted = committed._sum.amount ?? 0;
    const remaining = payment.amount - alreadyCommitted;
    const amount = dto.amount ?? remaining;

    if (amount <= 0 || amount > remaining) {
      throw AppException.unprocessable(
        ResponseCode.REFUND_EXCEEDS_PAYMENT,
        `${remaining} is left to refund on this payment.`,
      );
    }

    const refund = await this.prisma.refund.create({
      data: {
        paymentId: payment.id,
        deliveryId,
        amount,
        currency: payment.currency,
        reason: dto.reason,
        requestedByUserId: actorUserId,
      },
      select: { id: true },
    });

    await this.audit.record({
      actorUserId,
      action: 'refund.request',
      entityType: 'Refund',
      entityId: refund.id,
      summary: `Owed ${payment.currency} ${amount} back on ${payment.delivery.bookingCode}: ${dto.reason}`,
      after: { amount, currency: payment.currency, reason: dto.reason },
    });

    return this.findOne(refund.id);
  }

  /**
   * Records that the money actually went back.
   *
   * Requires the provider's reference for the same reason a payout settlement
   * does: a refund nobody can trace to a real transaction is indistinguishable
   * from one that never happened.
   */
  async settle(actorUserId: string, id: string, dto: AdminSettleRefundDto): Promise<AdminRefundDto> {
    const before = await this.findOne(id);

    const { count } = await this.prisma.refund.updateMany({
      where: { id, status: RefundStatus.PENDING },
      data: {
        status: RefundStatus.SETTLED,
        providerRef: dto.providerRef,
        settledByUserId: actorUserId,
        settledAt: new Date(),
      },
    });

    if (count === 0) throw AppException.conflict(ResponseCode.REFUND_NOT_SETTLEABLE);

    await this.markPaymentRefundedIfWhole(before.paymentId);

    await this.audit.record({
      actorUserId,
      action: 'refund.settle',
      entityType: 'Refund',
      entityId: id,
      summary: `Refunded ${before.currency} ${before.amount} on ${before.bookingCode} (${dto.providerRef})`,
      before: { status: before.status },
      after: { status: RefundStatus.SETTLED, providerRef: dto.providerRef },
    });

    return this.findOne(id);
  }

  /** The provider refused or the transfer bounced. The obligation stands. */
  async fail(actorUserId: string, id: string, dto: AdminReasonDto): Promise<AdminRefundDto> {
    const before = await this.findOne(id);

    const { count } = await this.prisma.refund.updateMany({
      where: { id, status: RefundStatus.PENDING },
      data: { status: RefundStatus.FAILED, failureReason: dto.reason, settledByUserId: actorUserId },
    });

    if (count === 0) throw AppException.conflict(ResponseCode.REFUND_NOT_SETTLEABLE);

    await this.audit.record({
      actorUserId,
      action: 'refund.fail',
      entityType: 'Refund',
      entityId: id,
      summary: `Refund of ${before.currency} ${before.amount} on ${before.bookingCode} failed: ${dto.reason}`,
      before: { status: before.status },
      after: { status: RefundStatus.FAILED, reason: dto.reason },
    });

    return this.findOne(id);
  }

  // ── Internals ──────────────────────────────────────────────────────────

  /**
   * A payment is REFUNDED only once every riel of it has gone back. A partial
   * refund leaves it PAID, because it is still, mostly, a payment.
   */
  private async markPaymentRefundedIfWhole(paymentId: string): Promise<void> {
    const [payment, settled] = await Promise.all([
      this.prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { amount: true } }),
      this.prisma.refund.aggregate({
        where: { paymentId, status: RefundStatus.SETTLED },
        _sum: { amount: true },
      }),
    ]);

    if ((settled._sum.amount ?? 0) >= payment.amount) {
      await this.prisma.payment.update({
        where: { id: paymentId },
        data: { status: PaymentStatus.REFUNDED },
      });
    }
  }

  private toRefund(row: Prisma.RefundGetPayload<{ select: typeof refundSelect }>): AdminRefundDto {
    return {
      id: row.id,
      paymentId: row.paymentId,
      deliveryId: row.deliveryId,
      bookingCode: row.delivery.bookingCode,
      customerName: row.delivery.customer.fullName,
      amount: row.amount,
      paymentAmount: row.payment.amount,
      currency: row.currency,
      method: row.payment.method,
      provider: row.payment.provider,
      status: row.status,
      reason: row.reason,
      providerRef: row.providerRef,
      failureReason: row.failureReason,
      requestedByName: row.requestedBy.adminProfile?.fullName ?? 'System',
      settledByName: row.settledBy?.adminProfile?.fullName ?? null,
      requestedAt: row.requestedAt.toISOString(),
      settledAt: row.settledAt?.toISOString() ?? null,
    };
  }
}
