import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
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
  AdminCancelDeliveryDto,
  AdminDeliveryDetailDto,
  AdminDeliveryQueryDto,
  AdminDeliveryRowDto,
  AdminDeliveryTimelineEntryDto,
  AdminLiveDeliveryDto,
  AdminReassignDeliveryDto,
} from '../dto/admin-delivery.dto.js';
import { AdminExportService } from '../services/admin-export.service.js';
import { RequirePermissions } from '../require-permissions.decorator.js';
import { AdminDeliveriesService } from '../services/admin-deliveries.service.js';

@ApiTags('Admin — Deliveries')
@Controller({ path: 'admin/deliveries', version: '1' })
export class AdminDeliveriesController {
  constructor(
    private readonly deliveries: AdminDeliveriesService,
    private readonly exports: AdminExportService,
  ) {}

  @Get()
  @RequirePermissions('deliveries.view')
  @ResponseCodeMeta(ResponseCode.DELIVERIES_FETCHED)
  @ApiOperation({
    summary: 'Every delivery on the platform',
    description:
      'Filterable by status, payment, party, vehicle type and date, and searchable by booking code, address or either party’s phone number. Unlike the customer’s own list, each row carries the commission and the driver earning.',
  })
  @ApiPaginatedResponse({ code: ResponseCode.DELIVERIES_FETCHED, type: AdminDeliveryRowDto })
  findAll(@Query() query: AdminDeliveryQueryDto): Promise<PaginatedResult<AdminDeliveryRowDto>> {
    return this.deliveries.findAll(query);
  }

  @Get('live')
  @RequirePermissions('deliveries.view')
  @ResponseCodeMeta(ResponseCode.LIVE_DELIVERIES_FETCHED)
  @ApiOperation({
    summary: 'Deliveries in motion, with driver positions',
    description:
      'The operations map. Driver positions come from the live presence store rather than the database, so this is cheap enough to poll.',
  })
  @ApiSuccessResponse({
    code: ResponseCode.LIVE_DELIVERIES_FETCHED,
    type: AdminLiveDeliveryDto,
    isArray: true,
  })
  live(): Promise<AdminLiveDeliveryDto[]> {
    return this.deliveries.live();
  }

  @Get('export')
  @RequirePermissions('deliveries.export')
  @ApiOperation({
    summary: 'Download deliveries as a spreadsheet',
    description:
      'Takes the same filters as the list, so an export is exactly what the screen is showing. Returns a CSV file rather than the response envelope. Money is written twice — an exact decimal for reading and the minor-unit integer the platform stores — with the currency in its own column. Exports are capped at 50,000 rows: past that the request is refused rather than silently truncated, because a file that stops halfway and looks complete is how figures quietly go missing. Every export is recorded in the audit log. Pagination does not apply — an export covers the whole filtered set. A value a spreadsheet would treat as a formula is prefixed with an apostrophe, which is why phone numbers in the file begin with one.',
  })
  @ApiOkResponse({ description: 'A CSV file.', content: { 'text/csv': {} } })
  @ApiErrorResponses({ status: 422, code: ResponseCode.EXPORT_TOO_LARGE })
  async export(
    @CurrentUser('userId') userId: string,
    @Query() query: AdminDeliveryQueryDto,
    @Res() response: Response,
  ): Promise<void> {
    await this.exports.deliveries(userId, this.deliveries.buildWhere(query), response);
  }

  @Get(':id')
  @RequirePermissions('deliveries.view')
  @ResponseCodeMeta(ResponseCode.DELIVERY_FETCHED)
  @ApiOperation({
    summary: 'One delivery in full',
    description:
      'Route, contacts, packages, proof of delivery, the price breakdown including the platform split, the status timeline, and the dispatch trail — every driver the job was offered to and what they did with it.',
  })
  @ApiSuccessResponse({ code: ResponseCode.DELIVERY_FETCHED, type: AdminDeliveryDetailDto })
  @ApiErrorResponses({ status: 404, code: ResponseCode.DELIVERY_NOT_FOUND })
  findOne(@Param() params: IdParamDto): Promise<AdminDeliveryDetailDto> {
    return this.deliveries.findOne(params.id);
  }

  @Get(':id/timeline')
  @RequirePermissions('deliveries.view')
  @ResponseCodeMeta(ResponseCode.DELIVERY_TIMELINE_FETCHED)
  @ApiOperation({
    summary: 'How a delivery reached its current status',
    description: 'Every status change, who made it, and why — the record a support case is settled from.',
  })
  @ApiSuccessResponse({
    code: ResponseCode.DELIVERY_TIMELINE_FETCHED,
    type: AdminDeliveryTimelineEntryDto,
    isArray: true,
  })
  @ApiErrorResponses({ status: 404, code: ResponseCode.DELIVERY_NOT_FOUND })
  timeline(@Param() params: IdParamDto): Promise<AdminDeliveryTimelineEntryDto[]> {
    return this.deliveries.timeline(params.id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('deliveries.cancel')
  @ResponseCodeMeta(ResponseCode.DELIVERY_CANCELLED)
  @ApiOperation({
    summary: 'Cancel on the customer’s behalf',
    description:
      'Support can cancel at any point before the delivery completes, including after pickup — precisely the case a customer cannot handle in the app. Outstanding driver offers are withdrawn, and the reason is recorded against the operator who made the call.',
  })
  @ApiSuccessResponse({ code: ResponseCode.DELIVERY_CANCELLED, type: AdminDeliveryDetailDto })
  @ApiErrorResponses(
    { status: 404, code: ResponseCode.DELIVERY_NOT_FOUND },
    { status: 409, code: ResponseCode.DELIVERY_ALREADY_CANCELLED },
    { status: 409, code: ResponseCode.DELIVERY_ALREADY_COMPLETED },
  )
  cancel(
    @CurrentUser('userId') userId: string,
    @Param() params: IdParamDto,
    @Body() dto: AdminCancelDeliveryDto,
  ): Promise<AdminDeliveryDetailDto> {
    return this.deliveries.cancel(userId, params.id, dto);
  }

  @Post(':id/reassign')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('deliveries.reassign')
  @ResponseCodeMeta(ResponseCode.DELIVERY_REASSIGNED)
  @ApiOperation({
    summary: 'Take the delivery off its driver and search again',
    description:
      'For an unreachable or stranded driver. The customer’s booking survives: it returns to SEARCHING_DRIVER, the matching rounds start over, and the released driver is not offered it again. Refused once the package has been collected — cancel instead.',
  })
  @ApiSuccessResponse({ code: ResponseCode.DELIVERY_REASSIGNED, type: AdminDeliveryDetailDto })
  @ApiErrorResponses(
    { status: 404, code: ResponseCode.DELIVERY_NOT_FOUND },
    { status: 422, code: ResponseCode.DELIVERY_NOT_REASSIGNABLE },
  )
  reassign(
    @CurrentUser('userId') userId: string,
    @Param() params: IdParamDto,
    @Body() dto: AdminReassignDeliveryDto,
  ): Promise<AdminDeliveryDetailDto> {
    return this.deliveries.reassign(userId, params.id, dto);
  }
}
