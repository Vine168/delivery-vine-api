import { Injectable } from '@nestjs/common';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import { PrismaService } from '../../database/prisma.service.js';
import { Currency } from '../../generated/prisma/enums.js';
import type { VehicleTypeDto } from './dto/vehicle-type.dto.js';

@Injectable()
export class VehicleTypesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Active vehicle types with the headline numbers from their current pricing
   * rule, so the booking screen can show "from ៛4,000" without a second call.
   */
  async findAll(currency: Currency = Currency.KHR): Promise<VehicleTypeDto[]> {
    const now = new Date();

    const types = await this.prisma.vehicleType.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        code: true,
        name: true,
        nameKm: true,
        description: true,
        iconUrl: true,
        maxWeightKg: true,
        maxPackages: true,
        pricingRules: {
          where: {
            currency,
            isActive: true,
            effectiveFrom: { lte: now },
            OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }],
          },
          orderBy: { priority: 'desc' },
          take: 1,
          select: { baseFare: true, pricePerKm: true, currency: true },
        },
      },
    });

    return types.map(({ pricingRules, ...type }) => {
      const rule = pricingRules[0];
      return {
        ...type,
        startingFare: rule ? { amount: rule.baseFare, currency: rule.currency } : null,
        pricePerKm: rule ? { amount: rule.pricePerKm, currency: rule.currency } : null,
      };
    });
  }

  /** Resolves a client-supplied vehicle type id, rejecting inactive ones. */
  async findActiveOrThrow(vehicleTypeId: string) {
    const type = await this.prisma.vehicleType.findUnique({
      where: { id: vehicleTypeId },
      select: { id: true, code: true, name: true, isActive: true, routingProfile: true, maxWeightKg: true, maxPackages: true },
    });

    if (!type) {
      throw AppException.notFound(ResponseCode.VEHICLE_TYPE_NOT_FOUND);
    }
    if (!type.isActive) {
      throw AppException.unprocessable(ResponseCode.VEHICLE_TYPE_INACTIVE, 'That vehicle type is not available.');
    }

    return type;
  }
}
