import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiErrorResponses,
  ApiPaginatedResponse,
  ApiSuccessResponse,
} from '../../../common/decorators/api-docs.decorator.js';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { ResponseCode as ResponseCodeMeta } from '../../../common/decorators/response-code.decorator.js';
import { ResponseCode } from '../../../common/constants/response-codes.js';
import { IdParamDto } from '../../../common/dto/id-param.dto.js';
import type { PaginatedResult } from '../../../common/interfaces/paginated.interface.js';
import {
  AdminCreatePricingRuleDto,
  AdminCreateVehicleTypeDto,
  AdminPricingRuleQueryDto,
  AdminUpdatePricingRuleDto,
  AdminUpdateVehicleTypeDto,
} from '../dto/admin-catalogue.dto.js';
import { AdminPricingRuleDto, AdminVehicleTypeDto } from '../dto/admin-catalogue-response.dto.js';
import { RequirePermissions } from '../require-permissions.decorator.js';
import { AdminCatalogueService } from '../services/admin-catalogue.service.js';

@ApiTags('Admin — Pricing')
@Controller({ path: 'admin/pricing', version: '1' })
export class AdminPricingController {
  constructor(private readonly catalogue: AdminCatalogueService) {}

  // ── Vehicle types ──────────────────────────────────────────────────────

  @Get('vehicle-types')
  @RequirePermissions('pricing.view')
  @ResponseCodeMeta(ResponseCode.VEHICLE_TYPES_FETCHED)
  @ApiOperation({
    summary: 'Vehicle types',
    description:
      'Each shows how many drivers use it and how many pricing rules price it — the two things that make deactivating one consequential.',
  })
  @ApiSuccessResponse({
    code: ResponseCode.VEHICLE_TYPES_FETCHED,
    type: AdminVehicleTypeDto,
    isArray: true,
  })
  findVehicleTypes(): Promise<AdminVehicleTypeDto[]> {
    return this.catalogue.findVehicleTypes();
  }

  @Post('vehicle-types')
  @RequirePermissions('pricing.manage')
  @ResponseCodeMeta(ResponseCode.VEHICLE_TYPE_CREATED)
  @ApiOperation({
    summary: 'Add a vehicle type',
    description:
      'The code is permanent in practice: it keys the driver presence indexes and appears in pricing. A new type has no pricing rule until one is created for it, so nothing can be booked with it yet.',
  })
  @ApiSuccessResponse({ status: 201, code: ResponseCode.VEHICLE_TYPE_CREATED, type: AdminVehicleTypeDto })
  @ApiErrorResponses(
    { status: 400, code: ResponseCode.VALIDATION_ERROR },
    { status: 409, code: ResponseCode.VEHICLE_TYPE_CODE_TAKEN },
  )
  createVehicleType(
    @CurrentUser('userId') userId: string,
    @Body() dto: AdminCreateVehicleTypeDto,
  ): Promise<AdminVehicleTypeDto> {
    return this.catalogue.createVehicleType(userId, dto);
  }

  @Patch('vehicle-types/:id')
  @RequirePermissions('pricing.manage')
  @ResponseCodeMeta(ResponseCode.VEHICLE_TYPE_UPDATED)
  @ApiOperation({
    summary: 'Change a vehicle type',
    description:
      'Deactivating one hides it from the customer app and stops new bookings. Deliveries already made keep it, which is why it is never deleted.',
  })
  @ApiSuccessResponse({ code: ResponseCode.VEHICLE_TYPE_UPDATED, type: AdminVehicleTypeDto })
  @ApiErrorResponses(
    { status: 404, code: ResponseCode.VEHICLE_TYPE_NOT_FOUND },
    { status: 409, code: ResponseCode.VEHICLE_TYPE_CODE_TAKEN },
  )
  updateVehicleType(
    @CurrentUser('userId') userId: string,
    @Param() params: IdParamDto,
    @Body() dto: AdminUpdateVehicleTypeDto,
  ): Promise<AdminVehicleTypeDto> {
    return this.catalogue.updateVehicleType(userId, params.id, dto);
  }

  // ── Rules ──────────────────────────────────────────────────────────────

  @Get('rules')
  @RequirePermissions('pricing.view')
  @ResponseCodeMeta(ResponseCode.PRICING_RULES_FETCHED)
  @ApiOperation({
    summary: 'Pricing rules',
    description:
      'Highest priority first — that is the order the pricing engine resolves them in when several match a booking.',
  })
  @ApiPaginatedResponse({ code: ResponseCode.PRICING_RULES_FETCHED, type: AdminPricingRuleDto })
  findRules(@Query() query: AdminPricingRuleQueryDto): Promise<PaginatedResult<AdminPricingRuleDto>> {
    return this.catalogue.findPricingRules(query);
  }

  @Get('rules/:id')
  @RequirePermissions('pricing.view')
  @ResponseCodeMeta(ResponseCode.PRICING_RULE_FETCHED)
  @ApiOperation({ summary: 'One pricing rule' })
  @ApiSuccessResponse({ code: ResponseCode.PRICING_RULE_FETCHED, type: AdminPricingRuleDto })
  @ApiErrorResponses({ status: 404, code: ResponseCode.PRICING_RULE_NOT_FOUND })
  findRule(@Param() params: IdParamDto): Promise<AdminPricingRuleDto> {
    return this.catalogue.findPricingRule(params.id);
  }

  @Post('rules')
  @RequirePermissions('pricing.manage')
  @ResponseCodeMeta(ResponseCode.PRICING_RULE_CREATED)
  @ApiOperation({
    summary: 'Add a pricing rule',
    description:
      'Every amount is in the rule’s own currency, in minor units; every rate is in basis points. A rule with a zone applies only inside it and outranks the equivalent rule without one.',
  })
  @ApiSuccessResponse({ status: 201, code: ResponseCode.PRICING_RULE_CREATED, type: AdminPricingRuleDto })
  @ApiErrorResponses(
    { status: 400, code: ResponseCode.VALIDATION_ERROR },
    { status: 404, code: ResponseCode.VEHICLE_TYPE_NOT_FOUND },
    { status: 404, code: ResponseCode.ZONE_NOT_FOUND },
  )
  createRule(
    @CurrentUser('userId') userId: string,
    @Body() dto: AdminCreatePricingRuleDto,
  ): Promise<AdminPricingRuleDto> {
    return this.catalogue.createPricingRule(userId, dto);
  }

  @Patch('rules/:id')
  @RequirePermissions('pricing.manage')
  @ResponseCodeMeta(ResponseCode.PRICING_RULE_UPDATED)
  @ApiOperation({
    summary: 'Change a pricing rule',
    description:
      'Affects the next booking only. Every delivery stores the price it was quoted and a snapshot of the inputs that produced it, so no historical amount, commission or driver earning moves when a rule changes. The rule’s version is bumped so the two can be told apart.',
  })
  @ApiSuccessResponse({ code: ResponseCode.PRICING_RULE_UPDATED, type: AdminPricingRuleDto })
  @ApiErrorResponses(
    { status: 400, code: ResponseCode.VALIDATION_ERROR },
    { status: 404, code: ResponseCode.PRICING_RULE_NOT_FOUND },
  )
  updateRule(
    @CurrentUser('userId') userId: string,
    @Param() params: IdParamDto,
    @Body() dto: AdminUpdatePricingRuleDto,
  ): Promise<AdminPricingRuleDto> {
    return this.catalogue.updatePricingRule(userId, params.id, dto);
  }

  @Delete('rules/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('pricing.manage')
  @ResponseCodeMeta(ResponseCode.PRICING_RULE_DEACTIVATED)
  @ApiOperation({
    summary: 'Retire a pricing rule',
    description:
      'Deactivates it. The row stays, because deliveries point at it and “which rule priced this?” has to stay answerable.',
  })
  @ApiSuccessResponse({ code: ResponseCode.PRICING_RULE_DEACTIVATED, type: AdminPricingRuleDto })
  @ApiErrorResponses({ status: 404, code: ResponseCode.PRICING_RULE_NOT_FOUND })
  deactivateRule(
    @CurrentUser('userId') userId: string,
    @Param() params: IdParamDto,
  ): Promise<AdminPricingRuleDto> {
    return this.catalogue.deactivatePricingRule(userId, params.id);
  }
}
