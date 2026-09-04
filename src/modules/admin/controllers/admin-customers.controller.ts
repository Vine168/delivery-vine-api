import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
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
  AdminCustomerDetailDto,
  AdminCustomerQueryDto,
  AdminCustomerRowDto,
} from '../dto/admin-customer.dto.js';
import { AdminReasonDto } from '../dto/admin-driver.dto.js';
import { RequirePermissions } from '../require-permissions.decorator.js';
import { AdminCustomersService } from '../services/admin-customers.service.js';

@ApiTags('Admin — Customers')
@Controller({ path: 'admin/customers', version: '1' })
export class AdminCustomersController {
  constructor(private readonly customers: AdminCustomersService) {}

  @Get()
  @RequirePermissions('customers.view')
  @ResponseCodeMeta(ResponseCode.ADMIN_CUSTOMERS_FETCHED)
  @ApiOperation({
    summary: 'Customer accounts',
    description: 'Searchable by name or phone number, filterable by account status and sign-up date.',
  })
  @ApiPaginatedResponse({ code: ResponseCode.ADMIN_CUSTOMERS_FETCHED, type: AdminCustomerRowDto })
  findAll(@Query() query: AdminCustomerQueryDto): Promise<PaginatedResult<AdminCustomerRowDto>> {
    return this.customers.findAll(query);
  }

  @Get(':id')
  @RequirePermissions('customers.view')
  @ResponseCodeMeta(ResponseCode.ADMIN_CUSTOMER_FETCHED)
  @ApiOperation({
    summary: 'One customer in full',
    description:
      'Profile, booking history counts, spend per currency, saved addresses and how many deliveries are running right now. Spend is never summed across currencies.',
  })
  @ApiSuccessResponse({ code: ResponseCode.ADMIN_CUSTOMER_FETCHED, type: AdminCustomerDetailDto })
  @ApiErrorResponses({ status: 404, code: ResponseCode.CUSTOMER_NOT_FOUND })
  findOne(@Param() params: IdParamDto): Promise<AdminCustomerDetailDto> {
    return this.customers.findOne(params.id);
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('customers.suspend')
  @ResponseCodeMeta(ResponseCode.CUSTOMER_SUSPENDED)
  @ApiOperation({
    summary: 'Stop a customer booking and signing in',
    description:
      'Revokes every open session and blocks login. Deliveries already in motion are left to finish — the driver is owed for them, and stopping them would punish everyone except the person being suspended.',
  })
  @ApiSuccessResponse({ code: ResponseCode.CUSTOMER_SUSPENDED, type: AdminCustomerDetailDto })
  @ApiErrorResponses(
    { status: 404, code: ResponseCode.CUSTOMER_NOT_FOUND },
    { status: 409, code: ResponseCode.ACCOUNT_SUSPENDED },
  )
  suspend(
    @CurrentUser('userId') userId: string,
    @Param() params: IdParamDto,
    @Body() dto: AdminReasonDto,
  ): Promise<AdminCustomerDetailDto> {
    return this.customers.suspend(userId, params.id, dto);
  }

  @Post(':id/reinstate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('customers.suspend')
  @ResponseCodeMeta(ResponseCode.CUSTOMER_REINSTATED)
  @ApiOperation({ summary: 'Lift a suspension' })
  @ApiSuccessResponse({ code: ResponseCode.CUSTOMER_REINSTATED, type: AdminCustomerDetailDto })
  @ApiErrorResponses(
    { status: 404, code: ResponseCode.CUSTOMER_NOT_FOUND },
    { status: 409, code: ResponseCode.CUSTOMER_NOT_SUSPENDED },
  )
  reinstate(
    @CurrentUser('userId') userId: string,
    @Param() params: IdParamDto,
  ): Promise<AdminCustomerDetailDto> {
    return this.customers.reinstate(userId, params.id);
  }
}
