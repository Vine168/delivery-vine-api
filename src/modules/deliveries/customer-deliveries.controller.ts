import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponses, ApiPaginatedResponse, ApiSuccessResponse } from '../../common/decorators/api-docs.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { ResponseCode as ResponseCodeMeta } from '../../common/decorators/response-code.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { IdParamDto } from '../../common/dto/id-param.dto.js';
import type { PaginatedResult } from '../../common/interfaces/paginated.interface.js';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface.js';
import { UserRole } from '../../generated/prisma/enums.js';
import { DeliveryQuoteService } from './delivery-quote.service.js';
import { DeliveryTrackingService } from './delivery-tracking.service.js';
import { DeliveryService } from './delivery.service.js';
import { CancelDeliveryDto, CreateDeliveryDto, QuoteDeliveryDto } from './dto/delivery-request.dto.js';
import { DeliveryTrackingDto } from './dto/tracking.dto.js';
import {
  DeliveryDto,
  DeliveryPackageViewDto,
  DeliverySummaryDto,
  ListDeliveriesQueryDto,
  QuoteDto,
} from './dto/delivery-response.dto.js';

@ApiTags('Customer Delivery')
@ApiBearerAuth()
@Roles(UserRole.CUSTOMER)
@Controller({ path: 'mobile/customer/deliveries', version: '1' })
export class CustomerDeliveriesController {
  constructor(
    private readonly deliveries: DeliveryService,
    private readonly quotes: DeliveryQuoteService,
    private readonly tracking: DeliveryTrackingService,
  ) {}

  @Post('quote')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ bucket: 'delivery:quote', limit: 60, windowSeconds: 60, by: 'user' })
  @ResponseCodeMeta(ResponseCode.QUOTE_CALCULATED)
  @ApiOperation({
    summary: 'Price a delivery before booking it',
    description:
      'Writes nothing. Returns the route, the full price breakdown and any promo discount. The price is recalculated when the booking is created, so a stale quote can never be banked.',
  })
  @ApiSuccessResponse({ code: ResponseCode.QUOTE_CALCULATED, type: QuoteDto })
  @ApiErrorResponses(
    { status: 400, code: ResponseCode.VALIDATION_ERROR },
    { status: 404, code: ResponseCode.VEHICLE_TYPE_NOT_FOUND },
    { status: 422, code: ResponseCode.DELIVERY_SAME_PICKUP_DROPOFF },
    { status: 422, code: ResponseCode.DELIVERY_DISTANCE_TOO_LONG },
    { status: 422, code: ResponseCode.PROMO_EXPIRED },
    { status: 503, code: ResponseCode.MAP_PROVIDER_UNAVAILABLE },
  )
  quote(@CurrentUser('customerId') customerId: string, @Body() dto: QuoteDeliveryDto): Promise<QuoteDto> {
    return this.quotes.quote(dto, customerId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ bucket: 'delivery:create', limit: 30, windowSeconds: 3600, by: 'user' })
  @ResponseCodeMeta(ResponseCode.DELIVERY_CREATED)
  @ApiOperation({
    summary: 'Create and confirm a booking',
    description:
      'The server recalculates the price from the pickup, drop-off and vehicle type — the amounts the app displays are never accepted as authoritative. On success the delivery is SEARCHING_DRIVER and matching begins.',
  })
  @ApiSuccessResponse({ status: 201, code: ResponseCode.DELIVERY_CREATED, type: DeliveryDto })
  @ApiErrorResponses(
    { status: 400, code: ResponseCode.VALIDATION_ERROR },
    { status: 400, code: ResponseCode.FILE_NOT_FOUND, description: 'A package photo does not belong to you.' },
    { status: 422, code: ResponseCode.DELIVERY_DISTANCE_TOO_LONG },
    { status: 422, code: ResponseCode.PROMO_CUSTOMER_LIMIT_REACHED },
  )
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateDeliveryDto): Promise<DeliveryDto> {
    return this.deliveries.create(user.customerId as string, user.userId, dto);
  }

  @Get()
  @ResponseCodeMeta(ResponseCode.DELIVERIES_FETCHED)
  @ApiOperation({
    summary: 'List your deliveries',
    description: 'Newest first. Filter by status (repeatable), date range, or search a booking code or address.',
  })
  @ApiPaginatedResponse({ code: ResponseCode.DELIVERIES_FETCHED, type: DeliverySummaryDto })
  findAll(
    @CurrentUser('customerId') customerId: string,
    @Query() query: ListDeliveriesQueryDto,
  ): Promise<PaginatedResult<DeliverySummaryDto>> {
    return this.deliveries.findAll(customerId, query);
  }

  @Get(':id')
  @ResponseCodeMeta(ResponseCode.DELIVERY_FETCHED)
  @ApiOperation({
    summary: 'Get one delivery',
    description: 'Includes the price breakdown, the packages, the assigned driver and the full status timeline.',
  })
  @ApiSuccessResponse({ code: ResponseCode.DELIVERY_FETCHED, type: DeliveryDto })
  @ApiErrorResponses({ status: 404, code: ResponseCode.DELIVERY_NOT_FOUND })
  findOne(@CurrentUser('customerId') customerId: string, @Param() params: IdParamDto): Promise<DeliveryDto> {
    return this.deliveries.findOne(customerId, params.id);
  }

  @Get(':id/packages')
  @ResponseCodeMeta(ResponseCode.DELIVERY_PACKAGES_FETCHED)
  @ApiOperation({ summary: 'List the packages on a delivery' })
  @ApiSuccessResponse({ code: ResponseCode.DELIVERY_PACKAGES_FETCHED, type: DeliveryPackageViewDto, isArray: true })
  @ApiErrorResponses({ status: 404, code: ResponseCode.DELIVERY_NOT_FOUND })
  findPackages(
    @CurrentUser('customerId') customerId: string,
    @Param() params: IdParamDto,
  ): Promise<DeliveryPackageViewDto[]> {
    return this.deliveries.findPackages(customerId, params.id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ResponseCodeMeta(ResponseCode.DELIVERY_CANCELLED)
  @ApiOperation({
    summary: 'Cancel a delivery',
    description:
      'Allowed until the driver has collected the package. Once it is picked up, cancelling is a support matter, not a tap.',
  })
  @ApiSuccessResponse({ code: ResponseCode.DELIVERY_CANCELLED, type: DeliveryDto })
  @ApiErrorResponses(
    { status: 404, code: ResponseCode.DELIVERY_NOT_FOUND },
    { status: 409, code: ResponseCode.DELIVERY_ALREADY_CANCELLED },
    { status: 409, code: ResponseCode.DELIVERY_ALREADY_COMPLETED },
    { status: 403, code: ResponseCode.DELIVERY_INVALID_TRANSITION, description: 'Too late to cancel from this status.' },
  )
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: IdParamDto,
    @Body() dto: CancelDeliveryDto,
  ): Promise<DeliveryDto> {
    return this.deliveries.cancel(user.customerId as string, user.userId, params.id, dto);
  }

  @Post(':id/rebook')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ bucket: 'delivery:create', limit: 30, windowSeconds: 3600, by: 'user' })
  @ResponseCodeMeta(ResponseCode.DELIVERY_REBOOKED)
  @ApiOperation({
    summary: 'Book the same route again',
    description: 'Copies the route, packages and payment method into a new booking, priced with today’s rules.',
  })
  @ApiSuccessResponse({ status: 201, code: ResponseCode.DELIVERY_REBOOKED, type: DeliveryDto })
  @ApiErrorResponses({ status: 404, code: ResponseCode.DELIVERY_NOT_FOUND })
  rebook(@CurrentUser() user: AuthenticatedUser, @Param() params: IdParamDto): Promise<DeliveryDto> {
    return this.deliveries.rebook(user.customerId as string, user.userId, params.id);
  }

  @Get(':id/tracking')
  @ResponseCodeMeta(ResponseCode.DELIVERY_TRACKING_FETCHED)
  @ApiOperation({
    summary: 'Track a delivery',
    description:
      'Status, driver, live position, ETA and the full timeline. The position comes from the live location stream rather than the database, and the ETA is a real route. Realtime updates arrive over the delivery socket room; this endpoint is the fallback and the initial load.',
  })
  @ApiSuccessResponse({ code: ResponseCode.DELIVERY_TRACKING_FETCHED, type: DeliveryTrackingDto })
  @ApiErrorResponses({ status: 404, code: ResponseCode.DELIVERY_NOT_FOUND })
  track(
    @CurrentUser('customerId') customerId: string,
    @Param() params: IdParamDto,
  ): Promise<DeliveryTrackingDto> {
    return this.tracking.track(customerId, params.id);
  }
}
