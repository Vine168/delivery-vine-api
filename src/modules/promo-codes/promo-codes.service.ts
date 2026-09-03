import { Injectable } from '@nestjs/common';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import { MoneyUtil } from '../../common/utils/money.util.js';
import { PrismaService } from '../../database/prisma.service.js';
import { Currency, DiscountType } from '../../generated/prisma/enums.js';
import type { PromoValidationDto } from './dto/promo.dto.js';

export interface AppliedPromo {
  promoCodeId: string;
  code: string;
  discountAmount: number;
  currency: Currency;
}

interface ValidateInput {
  code: string;
  customerId: string;
  subtotal: number;
  currency: Currency;
  vehicleTypeId?: string;
}

/**
 * Promo validation lives here, not in the delivery service, and is re-run when
 * the booking is written — a code that expired between the quote and the
 * confirmation must not be honoured.
 */
@Injectable()
export class PromoCodesService {
  constructor(private readonly prisma: PrismaService) {}

  async validate(input: ValidateInput): Promise<PromoValidationDto> {
    const code = input.code.trim().toUpperCase();
    const now = new Date();

    const promo = await this.prisma.promoCode.findFirst({
      where: { code, deletedAt: null },
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        currency: true,
        discountType: true,
        discountValue: true,
        maxDiscountAmount: true,
        minOrderAmount: true,
        startsAt: true,
        endsAt: true,
        usageLimit: true,
        usageCount: true,
        perCustomerLimit: true,
        isActive: true,
        vehicleTypes: { select: { vehicleTypeId: true } },
      },
    });

    if (!promo) {
      throw AppException.unprocessable(ResponseCode.PROMO_NOT_FOUND, 'That promo code does not exist.');
    }

    if (!promo.isActive) {
      throw AppException.unprocessable(ResponseCode.PROMO_INACTIVE, 'That promo code is no longer available.');
    }

    if (promo.startsAt > now) {
      throw AppException.unprocessable(ResponseCode.PROMO_NOT_STARTED, 'That promo code is not active yet.');
    }

    if (promo.endsAt < now) {
      throw AppException.unprocessable(ResponseCode.PROMO_EXPIRED, 'That promo code has expired.');
    }

    if (promo.currency !== input.currency) {
      throw AppException.unprocessable(
        ResponseCode.PROMO_CURRENCY_MISMATCH,
        `That promo code only applies to ${promo.currency} orders.`,
      );
    }

    if (promo.usageLimit !== null && promo.usageCount >= promo.usageLimit) {
      throw AppException.unprocessable(ResponseCode.PROMO_USAGE_LIMIT_REACHED, 'That promo code has been fully used.');
    }

    if (promo.minOrderAmount !== null && input.subtotal < promo.minOrderAmount) {
      throw AppException.unprocessable(
        ResponseCode.PROMO_MIN_ORDER_NOT_MET,
        `This promo needs an order of at least ${MoneyUtil.format({
          amount: promo.minOrderAmount,
          currency: promo.currency,
        })}.`,
      );
    }

    if (promo.vehicleTypes.length > 0) {
      const allowed = promo.vehicleTypes.some((row) => row.vehicleTypeId === input.vehicleTypeId);
      if (!allowed) {
        throw AppException.unprocessable(
          ResponseCode.PROMO_VEHICLE_NOT_ELIGIBLE,
          'That promo code does not apply to this vehicle type.',
        );
      }
    }

    let remainingUses: number | null = null;
    if (promo.perCustomerLimit !== null) {
      const used = await this.prisma.promoCodeUsage.count({
        where: { promoCodeId: promo.id, customerId: input.customerId },
      });

      if (used >= promo.perCustomerLimit) {
        throw AppException.unprocessable(
          ResponseCode.PROMO_CUSTOMER_LIMIT_REACHED,
          'You have already used that promo code.',
        );
      }

      remainingUses = promo.perCustomerLimit - used;
    }

    const discountAmount = this.discountFor(promo, input.subtotal);

    return {
      code: promo.code,
      name: promo.name,
      description: promo.description,
      discountType: promo.discountType,
      discountAmount,
      currency: promo.currency,
      totalAfterDiscount: input.subtotal - discountAmount,
      endsAt: promo.endsAt.toISOString(),
      remainingUses,
    };
  }

  /** Validation shaped for the pricing engine, which only needs the amount. */
  async apply(input: ValidateInput): Promise<AppliedPromo> {
    const validated = await this.validate(input);

    const promo = await this.prisma.promoCode.findFirstOrThrow({
      where: { code: validated.code, deletedAt: null },
      select: { id: true },
    });

    return {
      promoCodeId: promo.id,
      code: validated.code,
      discountAmount: validated.discountAmount,
      currency: validated.currency,
    };
  }

  /** Called inside the booking transaction so a usage cannot be double counted. */
  recordUsage(
    tx: Pick<PrismaService, 'promoCodeUsage' | 'promoCode'>,
    input: { promoCodeId: string; customerId: string; deliveryId: string; discountAmount: number; currency: Currency },
  ) {
    return Promise.all([
      tx.promoCodeUsage.create({
        data: {
          promoCodeId: input.promoCodeId,
          customerId: input.customerId,
          deliveryId: input.deliveryId,
          discountAmount: input.discountAmount,
          currency: input.currency,
        },
      }),
      tx.promoCode.update({
        where: { id: input.promoCodeId },
        data: { usageCount: { increment: 1 } },
      }),
    ]);
  }

  private discountFor(
    promo: { discountType: DiscountType; discountValue: number; maxDiscountAmount: number | null },
    subtotal: number,
  ): number {
    const raw =
      promo.discountType === DiscountType.PERCENTAGE
        ? MoneyUtil.percentOfBp(subtotal, promo.discountValue)
        : promo.discountValue;

    const capped = promo.maxDiscountAmount !== null ? Math.min(raw, promo.maxDiscountAmount) : raw;
    return Math.min(capped, subtotal);
  }
}
