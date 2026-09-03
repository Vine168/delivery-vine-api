import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DomainEvent, WsEvent } from '../../common/constants/events.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  DeliveryStatus,
  PaymentMethod,
  PaymentProvider as PaymentProviderName,
  PaymentStatus,
  PaymentTransactionType,
} from '../../generated/prisma/enums.js';
import { RealtimeEmitter } from '../../gateway/realtime.emitter.js';
import {
  PAYMENT_PROVIDERS,
  type ChargeRequest,
  type PaymentProvider,
} from './providers/payment-provider.interface.js';
import type { InitiatePaymentDto, PaymentDto, PaymentMethodDto } from './dto/payment.dto.js';

const METHOD_LABELS: Record<PaymentMethod, string> = {
  [PaymentMethod.CASH_ON_DELIVERY]: 'Cash on delivery',
  [PaymentMethod.ABA_KHQR]: 'ABA PayWay (KHQR)',
  [PaymentMethod.WALLET]: 'Wallet',
};

const PROVIDER_NAMES: Record<PaymentMethod, PaymentProviderName> = {
  [PaymentMethod.CASH_ON_DELIVERY]: PaymentProviderName.CASH,
  [PaymentMethod.ABA_KHQR]: PaymentProviderName.ABA_KHQR,
  [PaymentMethod.WALLET]: PaymentProviderName.INTERNAL,
};

const paymentSelect = {
  id: true,
  deliveryId: true,
  method: true,
  status: true,
  amount: true,
  currency: true,
  providerRef: true,
  qrString: true,
  deepLink: true,
  expiresAt: true,
  paidAt: true,
  failureReason: true,
  createdAt: true,
} as const;

/**
 * Taking money for a delivery.
 *
 * Providers do the talking; this service owns the record. Every interaction —
 * the charge, each verification, the outcome — is appended to
 * PaymentTransaction, so a disputed payment can be reconstructed from rows
 * rather than from logs.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly byMethod: Map<PaymentMethod, PaymentProvider>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly realtime: RealtimeEmitter,
    @Inject(PAYMENT_PROVIDERS) providers: PaymentProvider[],
  ) {
    this.byMethod = new Map(providers.map((provider) => [provider.method, provider]));
  }

  /** What this customer can actually choose, and why anything is missing. */
  listMethods(): PaymentMethodDto[] {
    return [PaymentMethod.CASH_ON_DELIVERY, PaymentMethod.ABA_KHQR].map((method) => {
      const provider = this.byMethod.get(method);

      return {
        method,
        label: METHOD_LABELS[method],
        available: provider?.isAvailable() ?? false,
        // `??` would have overwritten a provider's legitimate `null` (meaning
        // "available, no reason to give") with the missing-provider message.
        unavailableReason: provider ? provider.unavailableReason() : 'This payment method is not available.',
        prepaid: method !== PaymentMethod.CASH_ON_DELIVERY,
      };
    });
  }

  /**
   * Starts a payment for a delivery.
   *
   * Re-requesting while one is already open returns the existing payment
   * rather than issuing a second QR — a customer tapping twice should see the
   * same code, not two live charges.
   */
  async initiate(customerId: string, deliveryId: string, dto: InitiatePaymentDto): Promise<PaymentDto> {
    const delivery = await this.findDeliveryOrThrow(customerId, deliveryId);

    if (delivery.paymentStatus === PaymentStatus.PAID) {
      throw AppException.conflict(ResponseCode.PAYMENT_ALREADY_PAID, 'This delivery has already been paid.');
    }

    if (delivery.status === DeliveryStatus.CANCELLED || delivery.status === DeliveryStatus.EXPIRED) {
      throw AppException.unprocessable(
        ResponseCode.DELIVERY_INVALID_TRANSITION,
        'This delivery is no longer active.',
      );
    }

    const provider = this.providerFor(dto.method);

    const open = await this.prisma.payment.findFirst({
      where: {
        deliveryId,
        method: dto.method,
        status: { in: [PaymentStatus.PENDING, PaymentStatus.AWAITING_PAYMENT] },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { createdAt: 'desc' },
      select: paymentSelect,
    });

    if (open) {
      return this.toDto(open);
    }

    const payment = await this.prisma.payment.create({
      data: {
        deliveryId,
        method: dto.method,
        provider: PROVIDER_NAMES[dto.method],
        status: PaymentStatus.PENDING,
        amount: delivery.totalAmount,
        currency: delivery.currency,
      },
      select: paymentSelect,
    });

    const request: ChargeRequest = {
      paymentId: payment.id,
      bookingCode: delivery.bookingCode,
      amount: delivery.totalAmount,
      currency: delivery.currency,
      description: `Delivery ${delivery.bookingCode}`,
    };

    try {
      const result = await provider.charge(request);

      const updated = await this.prisma.$transaction(async (tx) => {
        const row = await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: result.status,
            providerRef: result.providerRef,
            qrString: result.qrString,
            deepLink: result.deepLink,
            expiresAt: result.expiresAt,
            metadata: result.metadata as never,
          },
          select: paymentSelect,
        });

        await tx.paymentTransaction.create({
          data: {
            paymentId: payment.id,
            type: PaymentTransactionType.CHARGE,
            status: result.status,
            amount: delivery.totalAmount,
            currency: delivery.currency,
            providerRef: result.providerRef,
            message: 'Charge created',
          },
        });

        await tx.delivery.update({
          where: { id: deliveryId },
          data: { paymentMethod: dto.method, paymentStatus: result.status },
        });

        return row;
      });

      return this.toDto(updated);
    } catch (error) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.FAILED,
          failureReason: error instanceof Error ? error.message : 'Provider error',
        },
      });
      throw error;
    }
  }

  /**
   * The customer's status check, which also asks the provider.
   *
   * Polling here rather than trusting a webhook alone means a lost callback
   * does not strand a paid delivery as unpaid.
   */
  async status(customerId: string, deliveryId: string): Promise<PaymentDto> {
    const delivery = await this.findDeliveryOrThrow(customerId, deliveryId);

    const payment = await this.prisma.payment.findFirst({
      where: { deliveryId },
      orderBy: { createdAt: 'desc' },
      select: paymentSelect,
    });

    if (!payment) {
      throw AppException.notFound(ResponseCode.PAYMENT_NOT_FOUND, 'No payment has been started for this delivery.');
    }

    if (payment.status !== PaymentStatus.AWAITING_PAYMENT) {
      return this.toDto(payment);
    }

    if (payment.expiresAt && payment.expiresAt.getTime() <= Date.now()) {
      return this.toDto(await this.expire(payment.id, deliveryId));
    }

    const refreshed = await this.refresh(payment, delivery.bookingCode);
    return this.toDto(refreshed);
  }

  /** Asks the provider and records the answer, whatever it is. */
  private async refresh(
    payment: { id: string; deliveryId: string; method: PaymentMethod; amount: number; currency: PaymentDto['currency']; providerRef: string | null; status: PaymentStatus },
    bookingCode: string,
  ) {
    const provider = this.providerFor(payment.method);

    const result = await provider.verify(payment.providerRef, {
      paymentId: payment.id,
      bookingCode,
      amount: payment.amount,
      currency: payment.currency,
      description: `Delivery ${bookingCode}`,
    });

    await this.prisma.paymentTransaction.create({
      data: {
        paymentId: payment.id,
        type: PaymentTransactionType.VERIFY,
        status: result.status,
        amount: payment.amount,
        currency: payment.currency,
        providerRef: result.providerRef ?? payment.providerRef,
        message: result.message,
        rawPayload: (result.raw ?? undefined) as never,
      },
    });

    if (result.status !== PaymentStatus.PAID) {
      return this.prisma.payment.findUniqueOrThrow({ where: { id: payment.id }, select: paymentSelect });
    }

    return this.markPaid(payment.id, payment.deliveryId);
  }

  /** The single path by which a delivery becomes paid. */
  async markPaid(paymentId: string, deliveryId: string) {
    const paidAt = new Date();

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.payment.update({
        where: { id: paymentId },
        data: { status: PaymentStatus.PAID, paidAt },
        select: paymentSelect,
      });

      await tx.delivery.update({
        where: { id: deliveryId },
        data: { paymentStatus: PaymentStatus.PAID },
      });

      return row;
    });

    this.events.emit(DomainEvent.PAYMENT_STATUS_CHANGED, { paymentId, deliveryId, status: PaymentStatus.PAID });
    this.realtime.toDelivery(deliveryId, WsEvent.DELIVERY_PAYMENT_UPDATED, {
      deliveryId,
      status: PaymentStatus.PAID,
      at: paidAt.toISOString(),
    });

    this.logger.log(`Payment ${paymentId} settled for delivery ${deliveryId}`);
    return updated;
  }

  private async expire(paymentId: string, deliveryId: string) {
    const updated = await this.prisma.payment.update({
      where: { id: paymentId },
      data: { status: PaymentStatus.EXPIRED, failureReason: 'The payment window closed.' },
      select: paymentSelect,
    });

    await this.prisma.delivery.updateMany({
      where: { id: deliveryId, paymentStatus: PaymentStatus.AWAITING_PAYMENT },
      data: { paymentStatus: PaymentStatus.PENDING },
    });

    return updated;
  }

  private providerFor(method: PaymentMethod): PaymentProvider {
    const provider = this.byMethod.get(method);

    if (!provider || !provider.isAvailable()) {
      throw AppException.unprocessable(
        ResponseCode.PAYMENT_METHOD_NOT_SUPPORTED,
        provider?.unavailableReason() ?? 'That payment method is not available.',
      );
    }

    return provider;
  }

  private async findDeliveryOrThrow(customerId: string, deliveryId: string) {
    const delivery = await this.prisma.delivery.findFirst({
      where: { id: deliveryId, customerId, deletedAt: null },
      select: {
        id: true,
        bookingCode: true,
        status: true,
        totalAmount: true,
        currency: true,
        paymentStatus: true,
      },
    });

    if (!delivery) {
      throw AppException.notFound(ResponseCode.DELIVERY_NOT_FOUND);
    }

    return delivery;
  }

  private toDto(payment: {
    id: string;
    deliveryId: string;
    method: PaymentMethod;
    status: PaymentStatus;
    amount: number;
    currency: PaymentDto['currency'];
    qrString: string | null;
    deepLink: string | null;
    expiresAt: Date | null;
    paidAt: Date | null;
    failureReason: string | null;
    createdAt: Date;
  }): PaymentDto {
    return {
      id: payment.id,
      deliveryId: payment.deliveryId,
      method: payment.method,
      status: payment.status,
      amount: payment.amount,
      currency: payment.currency,
      qrString: payment.qrString,
      deepLink: payment.deepLink,
      expiresAt: payment.expiresAt?.toISOString() ?? null,
      paidAt: payment.paidAt?.toISOString() ?? null,
      failureReason: payment.failureReason,
      createdAt: payment.createdAt.toISOString(),
    };
  }
}
