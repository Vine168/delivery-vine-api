import { Injectable } from '@nestjs/common';
import { LIMITS } from '../../common/constants/app.constants.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import { GeoUtil } from '../../common/utils/geo.util.js';
import { LocationsService } from '../locations/locations.service.js';
import type { RouteResult, RoutingProfile } from '../locations/providers/map-provider.interface.js';
import type { PriceBreakdownDto } from '../pricing/dto/price-breakdown.dto.js';
import { PricingService, type ResolvedPricingRule } from '../pricing/pricing.service.js';
import { PromoCodesService, type AppliedPromo } from '../promo-codes/promo-codes.service.js';
import { VehicleTypesService } from '../vehicle-types/vehicle-types.service.js';
import type { QuoteDeliveryDto } from './dto/delivery-request.dto.js';
import type { QuoteDto } from './dto/delivery-response.dto.js';

const QUOTE_VALIDITY_SECONDS = 600;

export interface PricedDelivery {
  vehicleType: { id: string; code: string; name: string; routingProfile: string; maxWeightKg: number | null; maxPackages: number | null };
  route: RouteResult;
  rule: ResolvedPricingRule;
  price: PriceBreakdownDto;
  promo: AppliedPromo | null;
}

/**
 * Turns a pickup, a drop-off and a vehicle type into a price.
 *
 * Used by both `POST /deliveries/quote` and `POST /deliveries`, so the number
 * the customer confirms is produced by exactly the same code that produced the
 * number they were shown — and the server recalculates rather than trusting
 * whatever the app sends back.
 */
@Injectable()
export class DeliveryQuoteService {
  constructor(
    private readonly locations: LocationsService,
    private readonly pricing: PricingService,
    private readonly promos: PromoCodesService,
    private readonly vehicleTypes: VehicleTypesService,
  ) {}

  async price(dto: QuoteDeliveryDto, customerId: string): Promise<PricedDelivery> {
    const pickup = { latitude: dto.pickup.latitude, longitude: dto.pickup.longitude };
    const dropoff = { latitude: dto.dropoff.latitude, longitude: dto.dropoff.longitude };

    const straightLine = GeoUtil.haversineMeters(pickup, dropoff);
    if (straightLine < LIMITS.MIN_PICKUP_DROPOFF_DISTANCE_METERS) {
      throw AppException.unprocessable(
        ResponseCode.DELIVERY_SAME_PICKUP_DROPOFF,
        'The pickup and drop-off points are too close together.',
      );
    }

    const vehicleType = await this.vehicleTypes.findActiveOrThrow(dto.vehicleTypeId);
    this.assertPackagesFit(dto, vehicleType);

    const route = await this.locations.route([pickup, dropoff], vehicleType.routingProfile as RoutingProfile);

    if (route.distanceMeters > LIMITS.MAX_DELIVERY_DISTANCE_METERS) {
      throw AppException.unprocessable(
        ResponseCode.DELIVERY_DISTANCE_TOO_LONG,
        `We can only deliver up to ${LIMITS.MAX_DELIVERY_DISTANCE_METERS / 1000} km.`,
      );
    }

    const rule = await this.pricing.resolveRule(vehicleType.id, dto.currency);
    const cod = this.normaliseCod(dto);

    // Priced twice on purpose: a promo's minimum-order rule and its percentage
    // both need the subtotal, which only exists after the first pass.
    const undiscounted = this.pricing.quote({
      rule,
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      cod,
    });

    let promo: AppliedPromo | null = null;
    if (dto.promoCode) {
      promo = await this.promos.apply({
        code: dto.promoCode,
        customerId,
        subtotal: undiscounted.subtotal,
        currency: dto.currency,
        vehicleTypeId: vehicleType.id,
      });
    }

    const price = promo
      ? this.pricing.quote({
          rule,
          distanceMeters: route.distanceMeters,
          durationSeconds: route.durationSeconds,
          cod,
          discountAmount: promo.discountAmount,
          promoCode: promo.code,
        })
      : undiscounted;

    return { vehicleType, route, rule, price, promo };
  }

  async quote(dto: QuoteDeliveryDto, customerId: string): Promise<QuoteDto> {
    const priced = await this.price(dto, customerId);

    return {
      distanceMeters: priced.route.distanceMeters,
      durationSeconds: priced.route.durationSeconds,
      routePolyline: priced.route.polyline,
      routeSource: priced.route.source,
      vehicleTypeCode: priced.vehicleType.code,
      price: priced.price,
      expiresAt: new Date(Date.now() + QUOTE_VALIDITY_SECONDS * 1000).toISOString(),
    };
  }

  /** COD only counts when it is switched on and has an amount to collect. */
  private normaliseCod(dto: QuoteDeliveryDto): { enabled: boolean; amount: number } | null {
    if (!dto.cod?.enabled) return null;

    if (!dto.cod.amount || dto.cod.amount <= 0) {
      throw AppException.badRequest(ResponseCode.VALIDATION_ERROR, 'Cash on delivery needs an amount to collect.', [
        { field: 'cod.amount', message: 'An amount is required when cash on delivery is enabled.' },
      ]);
    }

    return { enabled: true, amount: dto.cod.amount };
  }

  private assertPackagesFit(
    dto: QuoteDeliveryDto,
    vehicleType: { name: string; maxWeightKg: number | null; maxPackages: number | null },
  ): void {
    const packages = dto.packages ?? [];
    if (packages.length === 0) return;

    const totalItems = packages.reduce((total, item) => total + (item.quantity ?? 1), 0);
    const totalWeight = packages.reduce((total, item) => total + (item.weightKg ?? 0) * (item.quantity ?? 1), 0);

    if (vehicleType.maxPackages !== null && totalItems > vehicleType.maxPackages) {
      throw AppException.unprocessable(
        ResponseCode.VALIDATION_ERROR,
        `A ${vehicleType.name.toLowerCase()} can carry up to ${vehicleType.maxPackages} items.`,
      );
    }

    if (vehicleType.maxWeightKg !== null && totalWeight > vehicleType.maxWeightKg) {
      throw AppException.unprocessable(
        ResponseCode.VALIDATION_ERROR,
        `A ${vehicleType.name.toLowerCase()} can carry up to ${vehicleType.maxWeightKg} kg.`,
      );
    }
  }
}
