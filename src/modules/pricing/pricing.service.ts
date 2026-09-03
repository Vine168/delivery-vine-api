import { Injectable } from '@nestjs/common';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import { MoneyUtil } from '../../common/utils/money.util.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Currency } from '../../generated/prisma/enums.js';
import type { PriceBreakdownDto, PriceLineDto } from './dto/price-breakdown.dto.js';

export interface ResolvedPricingRule {
  id: string;
  name: string;
  currency: Currency;
  baseFare: number;
  includedDistanceMeters: number;
  pricePerKm: number;
  pricePerMinute: number;
  minimumFare: number;
  waitingFeePerMinute: number;
  freeWaitingSeconds: number;
  serviceFeeFlat: number;
  serviceFeePercentBp: number;
  codFeeFlat: number;
  codFeePercentBp: number;
  commissionPercentBp: number;
  minCommission: number | null;
  maxCommission: number | null;
  surgeMultiplierBp: number;
  version: number;
}

export interface QuoteInput {
  rule: ResolvedPricingRule;
  distanceMeters: number;
  durationSeconds: number;
  cod?: { enabled: boolean; amount: number } | null;
  discountAmount?: number;
  promoCode?: string | null;
  waitingSeconds?: number;
}

/**
 * The only place a price is calculated.
 *
 * Every input is an integer in the currency's minor unit and every rate is
 * basis points, so a fare can be reproduced exactly from the stored snapshot.
 * The mobile app's arithmetic is never trusted: it may show a quote, but this
 * service recalculates before a booking is written.
 */
@Injectable()
export class PricingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The active rule for a vehicle type and currency, highest priority first.
   * A missing rule is a configuration error, not a client error.
   */
  async resolveRule(vehicleTypeId: string, currency: Currency, zoneId?: string): Promise<ResolvedPricingRule> {
    const now = new Date();

    const rule = await this.prisma.pricingRule.findFirst({
      where: {
        vehicleTypeId,
        currency,
        isActive: true,
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }],
        ...(zoneId ? { OR: [{ zoneId }, { zoneId: null }] } : {}),
      },
      orderBy: [{ priority: 'desc' }, { effectiveFrom: 'desc' }],
      select: {
        id: true,
        name: true,
        currency: true,
        baseFare: true,
        includedDistanceMeters: true,
        pricePerKm: true,
        pricePerMinute: true,
        minimumFare: true,
        waitingFeePerMinute: true,
        freeWaitingSeconds: true,
        serviceFeeFlat: true,
        serviceFeePercentBp: true,
        codFeeFlat: true,
        codFeePercentBp: true,
        commissionPercentBp: true,
        minCommission: true,
        maxCommission: true,
        surgeMultiplierBp: true,
        version: true,
      },
    });

    if (!rule) {
      throw AppException.serviceUnavailable(
        ResponseCode.SERVICE_UNAVAILABLE,
        'Pricing is not configured for that vehicle type yet.',
      );
    }

    return rule;
  }

  /**
   * Turns a route and a rule into a full breakdown.
   *
   * Who pays for what:
   *  • `fareSubtotal` is the ride — base, distance, time, surge, waiting. The
   *    driver's share comes out of this.
   *  • Service and COD fees are platform revenue and sit outside the fare.
   *  • A promo discount reduces what the customer pays but never the driver's
   *    earning: the platform absorbs promotions, not the driver.
   */
  quote(input: QuoteInput): PriceBreakdownDto {
    const { rule } = input;
    const lines: PriceLineDto[] = [];

    const baseFare = rule.baseFare;
    lines.push({ code: 'BASE_FARE', label: 'Base fare', amount: baseFare });

    const chargeableMeters = Math.max(0, input.distanceMeters - rule.includedDistanceMeters);
    const distanceFare = Math.round((chargeableMeters / 1000) * rule.pricePerKm);
    if (distanceFare > 0) {
      lines.push({
        code: 'DISTANCE_FARE',
        label: `Distance (${(chargeableMeters / 1000).toFixed(1)} km)`,
        amount: distanceFare,
      });
    }

    const durationMinutes = input.durationSeconds / 60;
    const timeFare = rule.pricePerMinute > 0 ? Math.round(durationMinutes * rule.pricePerMinute) : 0;
    if (timeFare > 0) {
      lines.push({ code: 'TIME_FARE', label: `Time (${Math.round(durationMinutes)} min)`, amount: timeFare });
    }

    const chargeableWaiting = Math.max(0, (input.waitingSeconds ?? 0) - rule.freeWaitingSeconds);
    const waitingFee =
      rule.waitingFeePerMinute > 0 ? Math.round((chargeableWaiting / 60) * rule.waitingFeePerMinute) : 0;
    if (waitingFee > 0) {
      lines.push({ code: 'WAITING_FEE', label: 'Waiting time', amount: waitingFee });
    }

    const calculatedFare = baseFare + distanceFare + timeFare + waitingFee;
    const minimumFareApplied = calculatedFare < rule.minimumFare;
    const fareBeforeSurge = Math.max(calculatedFare, rule.minimumFare);

    if (minimumFareApplied) {
      lines.push({
        code: 'MINIMUM_FARE_ADJUSTMENT',
        label: 'Minimum fare',
        amount: rule.minimumFare - calculatedFare,
      });
    }

    const surgeAmount =
      rule.surgeMultiplierBp > 10_000 ? MoneyUtil.multiplyBp(fareBeforeSurge, rule.surgeMultiplierBp) - fareBeforeSurge : 0;
    if (surgeAmount > 0) {
      lines.push({
        code: 'SURGE',
        label: `Busy period (${(rule.surgeMultiplierBp / 100).toFixed(0)}%)`,
        amount: surgeAmount,
      });
    }

    const fareSubtotal = fareBeforeSurge + surgeAmount;

    const serviceFee = rule.serviceFeeFlat + MoneyUtil.percentOfBp(fareSubtotal, rule.serviceFeePercentBp);
    if (serviceFee > 0) {
      lines.push({ code: 'SERVICE_FEE', label: 'Service fee', amount: serviceFee });
    }

    const codEnabled = input.cod?.enabled === true && (input.cod?.amount ?? 0) > 0;
    const codFee = codEnabled ? rule.codFeeFlat + MoneyUtil.percentOfBp(input.cod!.amount, rule.codFeePercentBp) : 0;
    if (codFee > 0) {
      lines.push({ code: 'COD_FEE', label: 'Cash collection fee', amount: codFee });
    }

    const subtotal = fareSubtotal + serviceFee + codFee;

    // A discount can never exceed what is owed.
    const discountAmount = Math.min(Math.max(0, input.discountAmount ?? 0), subtotal);
    if (discountAmount > 0) {
      lines.push({
        code: 'DISCOUNT',
        label: input.promoCode ? `Promo ${input.promoCode}` : 'Discount',
        amount: -discountAmount,
      });
    }

    const totalAmount = MoneyUtil.roundToQuotable(subtotal - discountAmount, rule.currency);

    const commissionAmount = MoneyUtil.clamp(
      MoneyUtil.percentOfBp(fareSubtotal, rule.commissionPercentBp),
      rule.minCommission,
      // Commission can never exceed the fare it is taken from.
      rule.maxCommission === null ? fareSubtotal : Math.min(rule.maxCommission, fareSubtotal),
    );

    return {
      currency: rule.currency,
      baseFare,
      distanceFare,
      timeFare,
      waitingFee,
      surgeAmount,
      serviceFee,
      codFee,
      fareSubtotal,
      subtotal,
      discountAmount,
      totalAmount,
      commissionPercentBp: rule.commissionPercentBp,
      commissionAmount,
      driverEarningAmount: fareSubtotal - commissionAmount,
      minimumFareApplied,
      promoCode: input.promoCode ?? null,
      lines,
    };
  }

  /**
   * The immutable record kept on the delivery, so a completed booking can be
   * explained years later even if every pricing rule has changed since.
   */
  snapshot(breakdown: PriceBreakdownDto, rule: ResolvedPricingRule, route: { distanceMeters: number; durationSeconds: number; source: string }) {
    return {
      pricingRuleId: rule.id,
      pricingRuleName: rule.name,
      pricingRuleVersion: rule.version,
      calculatedAt: new Date().toISOString(),
      route,
      rule: {
        baseFare: rule.baseFare,
        includedDistanceMeters: rule.includedDistanceMeters,
        pricePerKm: rule.pricePerKm,
        pricePerMinute: rule.pricePerMinute,
        minimumFare: rule.minimumFare,
        serviceFeeFlat: rule.serviceFeeFlat,
        serviceFeePercentBp: rule.serviceFeePercentBp,
        codFeeFlat: rule.codFeeFlat,
        codFeePercentBp: rule.codFeePercentBp,
        commissionPercentBp: rule.commissionPercentBp,
        surgeMultiplierBp: rule.surgeMultiplierBp,
      },
      breakdown,
    };
  }
}
