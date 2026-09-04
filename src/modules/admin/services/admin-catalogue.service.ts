import { Injectable } from '@nestjs/common';
import { ResponseCode } from '../../../common/constants/response-codes.js';
import { AppException } from '../../../common/exceptions/app.exception.js';
import type { PaginatedResult } from '../../../common/interfaces/paginated.interface.js';
import { PaginationUtil } from '../../../common/utils/pagination.util.js';
import { PrismaService } from '../../../database/prisma.service.js';
import { Prisma } from '../../../generated/prisma/client.js';
import { ZoneCoverageType } from '../../../generated/prisma/enums.js';
import { AuditService } from '../audit.service.js';
import type {
  AdminCreatePricingRuleDto,
  AdminCreatePromoCodeDto,
  AdminCreateVehicleTypeDto,
  AdminCreateZoneDto,
  AdminPricingRuleQueryDto,
  AdminPromoCodeQueryDto,
  AdminUpdatePricingRuleDto,
  AdminUpdatePromoCodeDto,
  AdminUpdateVehicleTypeDto,
  AdminUpdateZoneDto,
  AdminZoneQueryDto,
} from '../dto/admin-catalogue.dto.js';
import type {
  AdminPricingRuleDto,
  AdminPromoCodeDto,
  AdminVehicleTypeDto,
  AdminZoneDto,
} from '../dto/admin-catalogue-response.dto.js';

const pricingSelect = {
  id: true,
  name: true,
  vehicleTypeId: true,
  zoneId: true,
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
  priority: true,
  isActive: true,
  effectiveFrom: true,
  effectiveTo: true,
  version: true,
  updatedAt: true,
  vehicleType: { select: { code: true } },
  zone: { select: { code: true } },
  _count: { select: { deliveries: true } },
} as const;

const promoSelect = {
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
  createdAt: true,
  vehicleTypes: { select: { vehicleType: { select: { code: true } } } },
} as const;

/**
 * The configuration behind pricing: vehicle types, zones, pricing rules and
 * promo codes.
 *
 * Editing any of these changes what the *next* booking costs and nothing else.
 * Every delivery stores the price it was quoted, the rule that produced it and
 * a full snapshot of the inputs, so a rule can be corrected, retired or
 * repriced without any historical figure moving. That is why these are plain
 * mutable rows rather than versioned records — the immutability that matters
 * already lives on the delivery.
 *
 * Nothing here is ever hard-deleted while something references it: a vehicle
 * type or zone with drivers or rules attached is deactivated instead, because
 * a delivery from last month must still be able to name what carried it.
 */
@Injectable()
export class AdminCatalogueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ── Vehicle types ──────────────────────────────────────────────────────

  async findVehicleTypes(): Promise<AdminVehicleTypeDto[]> {
    const rows = await this.prisma.vehicleType.findMany({
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      select: {
        id: true,
        code: true,
        name: true,
        nameKm: true,
        description: true,
        iconUrl: true,
        maxWeightKg: true,
        maxPackages: true,
        routingProfile: true,
        sortOrder: true,
        isActive: true,
        _count: { select: { vehicles: true, pricingRules: true } },
      },
    });

    return rows.map(({ _count, ...row }) => ({
      ...row,
      driverCount: _count.vehicles,
      pricingRuleCount: _count.pricingRules,
    }));
  }

  async createVehicleType(
    actorUserId: string,
    dto: AdminCreateVehicleTypeDto,
  ): Promise<AdminVehicleTypeDto> {
    const existing = await this.prisma.vehicleType.findUnique({ where: { code: dto.code } });
    if (existing) {
      throw AppException.conflict(ResponseCode.VEHICLE_TYPE_CODE_TAKEN);
    }

    const created = await this.prisma.vehicleType.create({ data: dto, select: { id: true } });

    await this.audit.record({
      actorUserId,
      action: 'vehicleType.create',
      entityType: 'VehicleType',
      entityId: created.id,
      summary: `Created vehicle type ${dto.code}`,
      after: { ...dto },
    });

    return this.vehicleType(created.id);
  }

  async updateVehicleType(
    actorUserId: string,
    id: string,
    dto: AdminUpdateVehicleTypeDto,
  ): Promise<AdminVehicleTypeDto> {
    const before = await this.vehicleType(id);

    if (dto.code && dto.code !== before.code) {
      const clash = await this.prisma.vehicleType.findUnique({ where: { code: dto.code } });
      if (clash) throw AppException.conflict(ResponseCode.VEHICLE_TYPE_CODE_TAKEN);
    }

    await this.prisma.vehicleType.update({ where: { id }, data: dto });

    await this.audit.record({
      actorUserId,
      action: 'vehicleType.update',
      entityType: 'VehicleType',
      entityId: id,
      summary: `Updated vehicle type ${before.code}`,
      before: { ...before },
      after: { ...dto },
    });

    return this.vehicleType(id);
  }

  // ── Zones ──────────────────────────────────────────────────────────────

  async findZones(query: AdminZoneQueryDto): Promise<PaginatedResult<AdminZoneDto>> {
    const where: Prisma.ZoneWhereInput = {
      deletedAt: null,
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.search
        ? {
            OR: [
              { code: { contains: query.search, mode: 'insensitive' } },
              { name: { contains: query.search, mode: 'insensitive' } },
              { city: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.zone.findMany({
        where,
        orderBy: { code: 'asc' },
        skip: query.skip,
        take: query.limit,
        select: this.zoneSelect(),
      }),
      this.prisma.zone.count({ where }),
    ]);

    return PaginationUtil.paginate(rows.map((row) => this.toZone(row)), query.page, query.limit, total);
  }

  async findZone(id: string): Promise<AdminZoneDto> {
    const zone = await this.prisma.zone.findFirst({
      where: { id, deletedAt: null },
      select: this.zoneSelect(),
    });

    if (!zone) throw AppException.notFound(ResponseCode.ZONE_NOT_FOUND);
    return this.toZone(zone);
  }

  async createZone(actorUserId: string, dto: AdminCreateZoneDto): Promise<AdminZoneDto> {
    const existing = await this.prisma.zone.findUnique({ where: { code: dto.code } });
    if (existing) throw AppException.conflict(ResponseCode.ZONE_CODE_TAKEN);

    const created = await this.prisma.zone.create({
      data: this.zoneData(dto) as Prisma.ZoneUncheckedCreateInput,
      select: { id: true },
    });

    await this.audit.record({
      actorUserId,
      action: 'zone.create',
      entityType: 'Zone',
      entityId: created.id,
      summary: `Created zone ${dto.code}`,
      after: { code: dto.code, name: dto.name, coverageType: dto.coverageType },
    });

    return this.findZone(created.id);
  }

  async updateZone(actorUserId: string, id: string, dto: AdminUpdateZoneDto): Promise<AdminZoneDto> {
    const before = await this.findZone(id);

    if (dto.code && dto.code !== before.code) {
      const clash = await this.prisma.zone.findUnique({ where: { code: dto.code } });
      if (clash) throw AppException.conflict(ResponseCode.ZONE_CODE_TAKEN);
    }

    await this.prisma.zone.update({ where: { id }, data: this.zoneData(dto) });

    await this.audit.record({
      actorUserId,
      action: 'zone.update',
      entityType: 'Zone',
      entityId: id,
      summary: `Updated zone ${before.code}`,
      before: { name: before.name, coverageType: before.coverageType, isActive: before.isActive },
      after: { ...dto },
    });

    return this.findZone(id);
  }

  /**
   * Retires a zone.
   *
   * Soft, always: pricing rules and driver assignments point at it, and a
   * delivery priced by a zone rule last month must still be explicable.
   */
  async deleteZone(actorUserId: string, id: string): Promise<void> {
    const zone = await this.findZone(id);

    await this.prisma.$transaction([
      this.prisma.zone.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } }),
      // Assignments to a retired zone mean nothing; drop them so the fleet
      // screen does not show drivers covering a zone that no longer exists.
      this.prisma.driverZone.deleteMany({ where: { zoneId: id } }),
    ]);

    await this.audit.record({
      actorUserId,
      action: 'zone.delete',
      entityType: 'Zone',
      entityId: id,
      summary: `Retired zone ${zone.code}`,
      before: { isActive: zone.isActive, driverCount: zone.driverCount },
      after: { isActive: false, deleted: true },
    });
  }

  // ── Pricing rules ──────────────────────────────────────────────────────

  async findPricingRules(query: AdminPricingRuleQueryDto): Promise<PaginatedResult<AdminPricingRuleDto>> {
    const where: Prisma.PricingRuleWhereInput = {
      ...(query.vehicleTypeId ? { vehicleTypeId: query.vehicleTypeId } : {}),
      ...(query.zoneId ? { zoneId: query.zoneId } : {}),
      ...(query.currency ? { currency: query.currency } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.pricingRule.findMany({
        where,
        orderBy: [{ priority: 'desc' }, { name: 'asc' }],
        skip: query.skip,
        take: query.limit,
        select: pricingSelect,
      }),
      this.prisma.pricingRule.count({ where }),
    ]);

    return PaginationUtil.paginate(rows.map((row) => this.toRule(row)), query.page, query.limit, total);
  }

  async findPricingRule(id: string): Promise<AdminPricingRuleDto> {
    const rule = await this.prisma.pricingRule.findUnique({ where: { id }, select: pricingSelect });
    if (!rule) throw AppException.notFound(ResponseCode.PRICING_RULE_NOT_FOUND);
    return this.toRule(rule);
  }

  async createPricingRule(
    actorUserId: string,
    dto: AdminCreatePricingRuleDto,
  ): Promise<AdminPricingRuleDto> {
    await this.assertReferences(dto.vehicleTypeId, dto.zoneId);
    this.assertCommissionBounds(dto.minCommission, dto.maxCommission);

    const created = await this.prisma.pricingRule.create({
      data: {
        ...dto,
        zoneId: dto.zoneId ?? null,
        effectiveFrom: dto.effectiveFrom ? new Date(dto.effectiveFrom) : undefined,
        effectiveTo: dto.effectiveTo ? new Date(dto.effectiveTo) : null,
      },
      select: { id: true },
    });

    await this.audit.record({
      actorUserId,
      action: 'pricingRule.create',
      entityType: 'PricingRule',
      entityId: created.id,
      summary: `Created pricing rule ${dto.name}`,
      after: { ...dto },
    });

    return this.findPricingRule(created.id);
  }

  /**
   * Edits a rule.
   *
   * `version` is bumped so a snapshot taken yesterday can be told apart from
   * one taken after the change. Deliveries already priced are untouched — they
   * carry their own snapshot, and nothing recomputes them.
   */
  async updatePricingRule(
    actorUserId: string,
    id: string,
    dto: AdminUpdatePricingRuleDto,
  ): Promise<AdminPricingRuleDto> {
    const before = await this.findPricingRule(id);

    if (dto.vehicleTypeId || dto.zoneId !== undefined) {
      await this.assertReferences(dto.vehicleTypeId ?? before.vehicleTypeId, dto.zoneId);
    }
    this.assertCommissionBounds(
      dto.minCommission === undefined ? before.minCommission : dto.minCommission,
      dto.maxCommission === undefined ? before.maxCommission : dto.maxCommission,
    );

    await this.prisma.pricingRule.update({
      where: { id },
      data: {
        ...dto,
        ...(dto.zoneId !== undefined ? { zoneId: dto.zoneId ?? null } : {}),
        ...(dto.effectiveFrom ? { effectiveFrom: new Date(dto.effectiveFrom) } : {}),
        ...(dto.effectiveTo !== undefined
          ? { effectiveTo: dto.effectiveTo ? new Date(dto.effectiveTo) : null }
          : {}),
        version: { increment: 1 },
      },
    });

    await this.audit.record({
      actorUserId,
      action: 'pricingRule.update',
      entityType: 'PricingRule',
      entityId: id,
      summary: `Updated pricing rule ${before.name} (version ${before.version} → ${before.version + 1})`,
      before: { ...before },
      after: { ...dto },
    });

    return this.findPricingRule(id);
  }

  /**
   * Retires a rule by deactivating it. Never deleted: deliveries reference it,
   * and "which rule priced this?" must stay answerable.
   */
  async deactivatePricingRule(actorUserId: string, id: string): Promise<AdminPricingRuleDto> {
    const before = await this.findPricingRule(id);

    await this.prisma.pricingRule.update({ where: { id }, data: { isActive: false } });

    await this.audit.record({
      actorUserId,
      action: 'pricingRule.deactivate',
      entityType: 'PricingRule',
      entityId: id,
      summary: `Retired pricing rule ${before.name}`,
      before: { isActive: before.isActive },
      after: { isActive: false },
    });

    return this.findPricingRule(id);
  }

  // ── Promo codes ────────────────────────────────────────────────────────

  async findPromoCodes(query: AdminPromoCodeQueryDto): Promise<PaginatedResult<AdminPromoCodeDto>> {
    const now = new Date();
    const where: Prisma.PromoCodeWhereInput = {
      deletedAt: null,
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.runningNow ? { isActive: true, startsAt: { lte: now }, endsAt: { gte: now } } : {}),
      ...(query.search
        ? {
            OR: [
              { code: { contains: query.search, mode: 'insensitive' } },
              { name: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.promoCode.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
        select: promoSelect,
      }),
      this.prisma.promoCode.count({ where }),
    ]);

    const spend = await this.discountGiven(rows.map((row) => row.id));

    return PaginationUtil.paginate(
      rows.map((row) => this.toPromo(row, spend.get(row.id) ?? 0)),
      query.page,
      query.limit,
      total,
    );
  }

  async findPromoCode(id: string): Promise<AdminPromoCodeDto> {
    const promo = await this.prisma.promoCode.findFirst({
      where: { id, deletedAt: null },
      select: promoSelect,
    });

    if (!promo) throw AppException.notFound(ResponseCode.PROMO_NOT_FOUND);

    const spend = await this.discountGiven([id]);
    return this.toPromo(promo, spend.get(id) ?? 0);
  }

  async createPromoCode(actorUserId: string, dto: AdminCreatePromoCodeDto): Promise<AdminPromoCodeDto> {
    const existing = await this.prisma.promoCode.findUnique({ where: { code: dto.code } });
    if (existing) throw AppException.conflict(ResponseCode.PROMO_CODE_TAKEN);

    this.assertWindow(dto.startsAt, dto.endsAt);
    this.assertDiscount(dto);

    const { vehicleTypeIds, ...fields } = dto;
    await this.assertVehicleTypes(vehicleTypeIds);

    const created = await this.prisma.promoCode.create({
      data: {
        ...fields,
        startsAt: new Date(dto.startsAt),
        endsAt: new Date(dto.endsAt),
        ...(vehicleTypeIds?.length
          ? { vehicleTypes: { create: vehicleTypeIds.map((vehicleTypeId) => ({ vehicleTypeId })) } }
          : {}),
      },
      select: { id: true },
    });

    await this.audit.record({
      actorUserId,
      action: 'promoCode.create',
      entityType: 'PromoCode',
      entityId: created.id,
      summary: `Created promo ${dto.code}`,
      after: { ...fields },
    });

    return this.findPromoCode(created.id);
  }

  /**
   * Edits a promo.
   *
   * The redemption count is never touched here: it is the record of what
   * customers actually did, and resetting it would let a capped promo be spent
   * twice. Discounts already applied are recorded on their deliveries and do
   * not move.
   */
  async updatePromoCode(
    actorUserId: string,
    id: string,
    dto: AdminUpdatePromoCodeDto,
  ): Promise<AdminPromoCodeDto> {
    const before = await this.findPromoCode(id);

    if (dto.code && dto.code !== before.code) {
      const clash = await this.prisma.promoCode.findUnique({ where: { code: dto.code } });
      if (clash) throw AppException.conflict(ResponseCode.PROMO_CODE_TAKEN);
    }

    const startsAt = dto.startsAt ?? before.startsAt;
    const endsAt = dto.endsAt ?? before.endsAt;
    this.assertWindow(startsAt, endsAt);
    this.assertDiscount({
      discountType: dto.discountType ?? before.discountType,
      discountValue: dto.discountValue ?? before.discountValue,
    });

    const { vehicleTypeIds, ...fields } = dto;
    await this.assertVehicleTypes(vehicleTypeIds);

    if (dto.usageLimit !== undefined && dto.usageLimit !== null && dto.usageLimit < before.usageCount) {
      throw AppException.unprocessable(
        ResponseCode.PROMO_LIMIT_BELOW_USAGE,
        `This code has already been used ${before.usageCount} times; the limit cannot be lower.`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.promoCode.update({
        where: { id },
        data: {
          ...fields,
          ...(dto.startsAt ? { startsAt: new Date(dto.startsAt) } : {}),
          ...(dto.endsAt ? { endsAt: new Date(dto.endsAt) } : {}),
        },
      });

      if (vehicleTypeIds) {
        await tx.promoCodeVehicleType.deleteMany({ where: { promoCodeId: id } });
        if (vehicleTypeIds.length > 0) {
          await tx.promoCodeVehicleType.createMany({
            data: vehicleTypeIds.map((vehicleTypeId) => ({ promoCodeId: id, vehicleTypeId })),
          });
        }
      }
    });

    await this.audit.record({
      actorUserId,
      action: 'promoCode.update',
      entityType: 'PromoCode',
      entityId: id,
      summary: `Updated promo ${before.code}`,
      before: { ...before },
      after: { ...fields },
    });

    return this.findPromoCode(id);
  }

  /** Withdraws a promo. Soft, because deliveries reference it. */
  async deletePromoCode(actorUserId: string, id: string): Promise<void> {
    const promo = await this.findPromoCode(id);

    await this.prisma.promoCode.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });

    await this.audit.record({
      actorUserId,
      action: 'promoCode.delete',
      entityType: 'PromoCode',
      entityId: id,
      summary: `Withdrew promo ${promo.code} after ${promo.usageCount} use(s)`,
      before: { isActive: promo.isActive, usageCount: promo.usageCount },
      after: { isActive: false, deleted: true },
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private zoneSelect() {
    return {
      id: true,
      code: true,
      name: true,
      description: true,
      city: true,
      coverageType: true,
      centerLatitude: true,
      centerLongitude: true,
      radiusMeters: true,
      boundary: true,
      isActive: true,
      createdAt: true,
      _count: { select: { drivers: true, pricingRules: true } },
    } as const;
  }

  /**
   * A zone is one shape or the other, never both.
   *
   * Storing a stale centre alongside a new polygon leaves two answers to
   * "where is this zone?", and whichever the next reader picks will sometimes
   * be wrong — so switching coverage clears what the other shape used.
   */
  private zoneData(dto: AdminCreateZoneDto | AdminUpdateZoneDto): Prisma.ZoneUncheckedUpdateInput {
    const { boundary, coverageType, centerLatitude, centerLongitude, radiusMeters, ...fields } = dto;
    const data: Prisma.ZoneUncheckedUpdateInput = { ...fields };

    if (coverageType) data.coverageType = coverageType;

    if (coverageType === ZoneCoverageType.RADIUS) {
      data.boundary = Prisma.DbNull;
      data.centerLatitude = centerLatitude ?? null;
      data.centerLongitude = centerLongitude ?? null;
      data.radiusMeters = radiusMeters ?? null;
      return data;
    }

    if (coverageType === ZoneCoverageType.POLYGON) {
      data.boundary = (boundary ?? Prisma.DbNull) as Prisma.InputJsonValue;
      data.centerLatitude = null;
      data.centerLongitude = null;
      data.radiusMeters = null;
      return data;
    }

    // No coverage change: only touch what was actually sent.
    if (boundary !== undefined) data.boundary = boundary as Prisma.InputJsonValue;
    if (centerLatitude !== undefined) data.centerLatitude = centerLatitude;
    if (centerLongitude !== undefined) data.centerLongitude = centerLongitude;
    if (radiusMeters !== undefined) data.radiusMeters = radiusMeters;

    return data;
  }

  private toZone(row: {
    id: string;
    code: string;
    name: string;
    description: string | null;
    city: string | null;
    coverageType: ZoneCoverageType;
    centerLatitude: number | null;
    centerLongitude: number | null;
    radiusMeters: number | null;
    boundary: unknown;
    isActive: boolean;
    createdAt: Date;
    _count: { drivers: number; pricingRules: number };
  }): AdminZoneDto {
    const { _count, boundary, createdAt, ...zone } = row;

    return {
      ...zone,
      boundary: (boundary as Record<string, unknown> | null) ?? null,
      driverCount: _count.drivers,
      pricingRuleCount: _count.pricingRules,
      createdAt: createdAt.toISOString(),
    };
  }

  private async vehicleType(id: string): Promise<AdminVehicleTypeDto> {
    const types = await this.findVehicleTypes();
    const found = types.find((type) => type.id === id);
    if (!found) throw AppException.notFound(ResponseCode.VEHICLE_TYPE_NOT_FOUND);
    return found;
  }

  private toRule(row: Prisma.PricingRuleGetPayload<{ select: typeof pricingSelect }>): AdminPricingRuleDto {
    const { vehicleType, zone, _count, effectiveFrom, effectiveTo, updatedAt, ...rule } = row;

    return {
      ...rule,
      vehicleTypeCode: vehicleType.code,
      zoneCode: zone?.code ?? null,
      effectiveFrom: effectiveFrom.toISOString(),
      effectiveTo: effectiveTo?.toISOString() ?? null,
      updatedAt: updatedAt.toISOString(),
      deliveryCount: _count.deliveries,
    };
  }

  private toPromo(
    row: Prisma.PromoCodeGetPayload<{ select: typeof promoSelect }>,
    discountGiven: number,
  ): AdminPromoCodeDto {
    const { vehicleTypes, startsAt, endsAt, createdAt, ...promo } = row;
    const now = Date.now();

    return {
      ...promo,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      createdAt: createdAt.toISOString(),
      isRunning:
        promo.isActive &&
        startsAt.getTime() <= now &&
        endsAt.getTime() >= now &&
        (promo.usageLimit === null || promo.usageCount < promo.usageLimit),
      vehicleTypeCodes: vehicleTypes.map((link) => link.vehicleType.code),
      discountGiven,
    };
  }

  /** What each promo has actually cost, from the usage rows rather than a counter. */
  private async discountGiven(promoCodeIds: string[]): Promise<Map<string, number>> {
    if (promoCodeIds.length === 0) return new Map();

    const totals = await this.prisma.promoCodeUsage.groupBy({
      by: ['promoCodeId'],
      where: { promoCodeId: { in: promoCodeIds } },
      _sum: { discountAmount: true },
    });

    return new Map(totals.map((row) => [row.promoCodeId, row._sum.discountAmount ?? 0]));
  }

  private async assertReferences(vehicleTypeId: string, zoneId?: string | null): Promise<void> {
    const vehicleType = await this.prisma.vehicleType.findUnique({ where: { id: vehicleTypeId } });
    if (!vehicleType) throw AppException.notFound(ResponseCode.VEHICLE_TYPE_NOT_FOUND);

    if (zoneId) {
      const zone = await this.prisma.zone.findFirst({ where: { id: zoneId, deletedAt: null } });
      if (!zone) throw AppException.notFound(ResponseCode.ZONE_NOT_FOUND);
    }
  }

  private async assertVehicleTypes(ids?: string[]): Promise<void> {
    if (!ids?.length) return;

    const found = await this.prisma.vehicleType.count({ where: { id: { in: ids } } });
    if (found !== new Set(ids).size) {
      throw AppException.notFound(ResponseCode.VEHICLE_TYPE_NOT_FOUND, 'One or more vehicle types do not exist.');
    }
  }

  private assertCommissionBounds(min: number | null | undefined, max: number | null | undefined): void {
    if (min != null && max != null && min > max) {
      throw AppException.unprocessable(
        ResponseCode.VALIDATION_ERROR,
        'The minimum commission cannot be greater than the maximum.',
      );
    }
  }

  private assertWindow(startsAt: string, endsAt: string): void {
    if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
      throw AppException.unprocessable(
        ResponseCode.VALIDATION_ERROR,
        'A promo code must end after it starts.',
      );
    }
  }

  private assertDiscount(dto: { discountType: string; discountValue: number }): void {
    if (dto.discountType === 'PERCENTAGE' && dto.discountValue > 10_000) {
      throw AppException.unprocessable(
        ResponseCode.VALIDATION_ERROR,
        'A percentage discount cannot exceed 100% (10000 basis points).',
      );
    }
  }
}
