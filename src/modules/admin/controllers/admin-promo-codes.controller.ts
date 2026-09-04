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
  AdminCreatePromoCodeDto,
  AdminPromoCodeQueryDto,
  AdminUpdatePromoCodeDto,
} from '../dto/admin-catalogue.dto.js';
import { AdminPromoCodeDto } from '../dto/admin-catalogue-response.dto.js';
import { RequirePermissions } from '../require-permissions.decorator.js';
import { AdminCatalogueService } from '../services/admin-catalogue.service.js';

@ApiTags('Admin — Promo codes')
@Controller({ path: 'admin/promo-codes', version: '1' })
export class AdminPromoCodesController {
  constructor(private readonly catalogue: AdminCatalogueService) {}

  @Get()
  @RequirePermissions('promoCodes.view')
  @ResponseCodeMeta(ResponseCode.PROMO_CODES_FETCHED)
  @ApiOperation({
    summary: 'Promo codes',
    description:
      '`isRunning` answers the question the screen is really asking — whether a customer could use it right now, which needs the code to be active, inside its window and not used up. `discountGiven` is summed from actual redemptions, not from the counter.',
  })
  @ApiPaginatedResponse({ code: ResponseCode.PROMO_CODES_FETCHED, type: AdminPromoCodeDto })
  findAll(@Query() query: AdminPromoCodeQueryDto): Promise<PaginatedResult<AdminPromoCodeDto>> {
    return this.catalogue.findPromoCodes(query);
  }

  @Get(':id')
  @RequirePermissions('promoCodes.view')
  @ResponseCodeMeta(ResponseCode.PROMO_CODE_FETCHED)
  @ApiOperation({ summary: 'One promo code' })
  @ApiSuccessResponse({ code: ResponseCode.PROMO_CODE_FETCHED, type: AdminPromoCodeDto })
  @ApiErrorResponses({ status: 404, code: ResponseCode.PROMO_NOT_FOUND })
  findOne(@Param() params: IdParamDto): Promise<AdminPromoCodeDto> {
    return this.catalogue.findPromoCode(params.id);
  }

  @Post()
  @RequirePermissions('promoCodes.manage')
  @ResponseCodeMeta(ResponseCode.PROMO_CODE_CREATED)
  @ApiOperation({
    summary: 'Create a promo code',
    description:
      'A promo belongs to one currency and only discounts bookings priced in it — there is no conversion, because a “៛500 off” offer is not a “$0.12 off” offer. Percentages are basis points; fixed amounts are minor units.',
  })
  @ApiSuccessResponse({ status: 201, code: ResponseCode.PROMO_CODE_CREATED, type: AdminPromoCodeDto })
  @ApiErrorResponses(
    { status: 400, code: ResponseCode.VALIDATION_ERROR },
    { status: 404, code: ResponseCode.VEHICLE_TYPE_NOT_FOUND },
    { status: 409, code: ResponseCode.PROMO_CODE_TAKEN },
  )
  create(
    @CurrentUser('userId') userId: string,
    @Body() dto: AdminCreatePromoCodeDto,
  ): Promise<AdminPromoCodeDto> {
    return this.catalogue.createPromoCode(userId, dto);
  }

  @Patch(':id')
  @RequirePermissions('promoCodes.manage')
  @ResponseCodeMeta(ResponseCode.PROMO_CODE_UPDATED)
  @ApiOperation({
    summary: 'Change a promo code',
    description:
      'The redemption count is never editable — it records what customers actually did, and resetting it would let a capped offer be spent twice. A usage limit cannot be set below what has already been redeemed. Discounts already given are recorded on their deliveries and do not move.',
  })
  @ApiSuccessResponse({ code: ResponseCode.PROMO_CODE_UPDATED, type: AdminPromoCodeDto })
  @ApiErrorResponses(
    { status: 404, code: ResponseCode.PROMO_NOT_FOUND },
    { status: 409, code: ResponseCode.PROMO_CODE_TAKEN },
    { status: 422, code: ResponseCode.PROMO_LIMIT_BELOW_USAGE },
  )
  update(
    @CurrentUser('userId') userId: string,
    @Param() params: IdParamDto,
    @Body() dto: AdminUpdatePromoCodeDto,
  ): Promise<AdminPromoCodeDto> {
    return this.catalogue.updatePromoCode(userId, params.id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('promoCodes.manage')
  @ResponseCodeMeta(ResponseCode.PROMO_CODE_DELETED)
  @ApiOperation({
    summary: 'Withdraw a promo code',
    description: 'Soft: deliveries that used it point at it, and their discounts must stay explicable.',
  })
  @ApiSuccessResponse({ code: ResponseCode.PROMO_CODE_DELETED })
  @ApiErrorResponses({ status: 404, code: ResponseCode.PROMO_NOT_FOUND })
  async remove(@CurrentUser('userId') userId: string, @Param() params: IdParamDto): Promise<void> {
    await this.catalogue.deletePromoCode(userId, params.id);
  }
}
