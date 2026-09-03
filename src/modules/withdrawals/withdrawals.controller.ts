import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponses, ApiPaginatedResponse, ApiSuccessResponse } from '../../common/decorators/api-docs.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { ResponseCode as ResponseCodeMeta } from '../../common/decorators/response-code.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { IdParamDto } from '../../common/dto/id-param.dto.js';
import type { PaginatedResult } from '../../common/interfaces/paginated.interface.js';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface.js';
import { UserRole } from '../../generated/prisma/enums.js';
import { WithdrawalsService } from './withdrawals.service.js';
import {
  CreateWithdrawalDto,
  ListWithdrawalsQueryDto,
  UpdateWithdrawalSettingsDto,
  WithdrawalDto,
  WithdrawalSettingsDto,
} from './dto/withdrawal.dto.js';

@ApiTags('Driver Wallet')
@ApiBearerAuth()
@Roles(UserRole.DRIVER)
@Controller({ path: 'mobile/driver', version: '1' })
export class WithdrawalsController {
  constructor(private readonly withdrawals: WithdrawalsService) {}

  @Get('withdrawal-settings')
  @ResponseCodeMeta(ResponseCode.WITHDRAWAL_SETTINGS_FETCHED)
  @ApiOperation({
    summary: 'Bank details for payouts',
    description: 'The account number is stored encrypted; only its last four digits are ever returned.',
  })
  @ApiSuccessResponse({ code: ResponseCode.WITHDRAWAL_SETTINGS_FETCHED, type: WithdrawalSettingsDto })
  getSettings(@CurrentUser('driverId') driverId: string): Promise<WithdrawalSettingsDto> {
    return this.withdrawals.getSettings(driverId);
  }

  @Put('withdrawal-settings')
  @ResponseCodeMeta(ResponseCode.WITHDRAWAL_SETTINGS_UPDATED)
  @ApiOperation({ summary: 'Set or replace your bank details' })
  @ApiSuccessResponse({ code: ResponseCode.WITHDRAWAL_SETTINGS_UPDATED, type: WithdrawalSettingsDto })
  @ApiErrorResponses(
    { status: 400, code: ResponseCode.VALIDATION_ERROR },
    { status: 400, code: ResponseCode.FILE_NOT_FOUND },
  )
  updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateWithdrawalSettingsDto,
  ): Promise<WithdrawalSettingsDto> {
    return this.withdrawals.updateSettings(user.driverId as string, user.userId, dto);
  }

  @Post('withdrawals')
  @HttpCode(HttpStatus.CREATED)
  @ResponseCodeMeta(ResponseCode.WITHDRAWAL_REQUESTED)
  @ApiOperation({
    summary: 'Request a payout',
    description:
      'The amount is reserved immediately, so it cannot be requested twice, but it does not leave the wallet until the transfer actually settles. Only one request may be open at a time.',
  })
  @ApiSuccessResponse({ status: 201, code: ResponseCode.WITHDRAWAL_REQUESTED, type: WithdrawalDto })
  @ApiErrorResponses(
    { status: 409, code: ResponseCode.WITHDRAWAL_PENDING_EXISTS },
    { status: 422, code: ResponseCode.WITHDRAWAL_SETTINGS_REQUIRED },
    { status: 422, code: ResponseCode.INSUFFICIENT_BALANCE },
    { status: 422, code: ResponseCode.WITHDRAWAL_AMOUNT_TOO_LOW },
    { status: 422, code: ResponseCode.WITHDRAWAL_AMOUNT_TOO_HIGH },
  )
  request(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateWithdrawalDto): Promise<WithdrawalDto> {
    return this.withdrawals.request(user.driverId as string, user.userId, dto);
  }

  @Get('withdrawals')
  @ResponseCodeMeta(ResponseCode.WITHDRAWALS_FETCHED)
  @ApiOperation({ summary: 'Your payout requests, newest first' })
  @ApiPaginatedResponse({ code: ResponseCode.WITHDRAWALS_FETCHED, type: WithdrawalDto })
  findAll(
    @CurrentUser('driverId') driverId: string,
    @Query() query: ListWithdrawalsQueryDto,
  ): Promise<PaginatedResult<WithdrawalDto>> {
    return this.withdrawals.findAll(driverId, query);
  }

  @Get('withdrawals/:id')
  @ResponseCodeMeta(ResponseCode.WITHDRAWAL_FETCHED)
  @ApiOperation({ summary: 'One payout request' })
  @ApiSuccessResponse({ code: ResponseCode.WITHDRAWAL_FETCHED, type: WithdrawalDto })
  @ApiErrorResponses({ status: 404, code: ResponseCode.WITHDRAWAL_NOT_FOUND })
  findOne(@CurrentUser('driverId') driverId: string, @Param() params: IdParamDto): Promise<WithdrawalDto> {
    return this.withdrawals.findOne(driverId, params.id);
  }

  @Post('withdrawals/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ResponseCodeMeta(ResponseCode.WITHDRAWAL_CANCELLED)
  @ApiOperation({
    summary: 'Cancel a payout request',
    description: 'Only while it is still pending. The reserved amount returns to your available balance.',
  })
  @ApiSuccessResponse({ code: ResponseCode.WITHDRAWAL_CANCELLED, type: WithdrawalDto })
  @ApiErrorResponses(
    { status: 404, code: ResponseCode.WITHDRAWAL_NOT_FOUND },
    { status: 409, code: ResponseCode.WITHDRAWAL_NOT_CANCELLABLE },
  )
  cancel(@CurrentUser('driverId') driverId: string, @Param() params: IdParamDto): Promise<WithdrawalDto> {
    return this.withdrawals.cancel(driverId, params.id);
  }
}
