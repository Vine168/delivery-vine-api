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
import { AdminReasonDto } from '../dto/admin-driver.dto.js';
import {
  AdminEarningQueryDto,
  AdminEarningRowDto,
  AdminFinanceOverviewDto,
  AdminFinanceQueryDto,
  AdminPaymentQueryDto,
  AdminPaymentRowDto,
  AdminPayoutDetailsDto,
  AdminSettleWithdrawalDto,
  AdminWalletAdjustmentDto,
  AdminWalletTransactionDto,
  AdminWalletTransactionQueryDto,
  AdminWithdrawalDetailDto,
  AdminWithdrawalQueryDto,
  AdminWithdrawalRowDto,
} from '../dto/admin-finance.dto.js';
import { RequirePermissions } from '../require-permissions.decorator.js';
import { AdminFinanceService } from '../services/admin-finance.service.js';

@ApiTags('Admin — Finance')
@Controller({ path: 'admin/finance', version: '1' })
export class AdminFinanceController {
  constructor(private readonly finance: AdminFinanceService) {}

  @Get('overview')
  @RequirePermissions('finance.view')
  @ResponseCodeMeta(ResponseCode.FINANCE_OVERVIEW_FETCHED)
  @ApiOperation({
    summary: 'Revenue, liabilities, payouts and payments',
    description:
      'Revenue and payments belong to the reporting window; liabilities and open withdrawal queues are a position and are always current. Every figure is per currency in minor units — KHR and USD are never added together. Nothing is recomputed from today’s pricing: the numbers come from what was written when each delivery settled.',
  })
  @ApiSuccessResponse({ code: ResponseCode.FINANCE_OVERVIEW_FETCHED, type: AdminFinanceOverviewDto })
  overview(@Query() query: AdminFinanceQueryDto): Promise<AdminFinanceOverviewDto> {
    return this.finance.overview(query);
  }

  // ── Withdrawals ────────────────────────────────────────────────────────

  @Get('withdrawals')
  @RequirePermissions('finance.view')
  @ResponseCodeMeta(ResponseCode.WITHDRAWALS_FETCHED)
  @ApiOperation({
    summary: 'Payout requests',
    description:
      'Oldest first — this is a work queue, and the driver who has waited longest should be paid first. Bank details show only the last four digits.',
  })
  @ApiPaginatedResponse({ code: ResponseCode.WITHDRAWALS_FETCHED, type: AdminWithdrawalRowDto })
  findWithdrawals(
    @Query() query: AdminWithdrawalQueryDto,
  ): Promise<PaginatedResult<AdminWithdrawalRowDto>> {
    return this.finance.findWithdrawals(query);
  }

  @Get('withdrawals/:id')
  @RequirePermissions('finance.view')
  @ResponseCodeMeta(ResponseCode.WITHDRAWAL_FETCHED)
  @ApiOperation({
    summary: 'One payout request',
    description: 'Includes the driver’s current wallet position and how many payouts they have had before.',
  })
  @ApiSuccessResponse({ code: ResponseCode.WITHDRAWAL_FETCHED, type: AdminWithdrawalDetailDto })
  @ApiErrorResponses({ status: 404, code: ResponseCode.WITHDRAWAL_NOT_FOUND })
  findWithdrawal(@Param() params: IdParamDto): Promise<AdminWithdrawalDetailDto> {
    return this.finance.findWithdrawal(params.id);
  }

  @Get('withdrawals/:id/payout-details')
  @RequirePermissions('finance.withdrawals.settle')
  @ResponseCodeMeta(ResponseCode.PAYOUT_DETAILS_FETCHED)
  @ApiOperation({
    summary: 'The full bank account number',
    description:
      'For the person actually making the transfer. Everywhere else shows the last four digits; this decrypts the stored number, and every call writes an audit entry naming who read it.',
  })
  @ApiSuccessResponse({ code: ResponseCode.PAYOUT_DETAILS_FETCHED, type: AdminPayoutDetailsDto })
  @ApiErrorResponses(
    { status: 404, code: ResponseCode.WITHDRAWAL_NOT_FOUND },
    { status: 422, code: ResponseCode.WITHDRAWAL_SETTINGS_REQUIRED },
  )
  payoutDetails(
    @CurrentUser('userId') userId: string,
    @Param() params: IdParamDto,
  ): Promise<AdminPayoutDetailsDto> {
    return this.finance.payoutDetails(userId, params.id);
  }

  @Post('withdrawals/:id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('finance.withdrawals.review')
  @ResponseCodeMeta(ResponseCode.WITHDRAWAL_APPROVED)
  @ApiOperation({
    summary: 'Accept a payout request',
    description:
      'Clears it for payment. No money moves — the funds stay reserved until someone records that the bank actually paid it.',
  })
  @ApiSuccessResponse({ code: ResponseCode.WITHDRAWAL_APPROVED, type: AdminWithdrawalDetailDto })
  @ApiErrorResponses(
    { status: 404, code: ResponseCode.WITHDRAWAL_NOT_FOUND },
    { status: 409, code: ResponseCode.CONFLICT, description: 'The request is no longer pending.' },
  )
  approve(
    @CurrentUser('userId') userId: string,
    @Param() params: IdParamDto,
  ): Promise<AdminWithdrawalDetailDto> {
    return this.finance.approveWithdrawal(userId, params.id);
  }

  @Post('withdrawals/:id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('finance.withdrawals.review')
  @ResponseCodeMeta(ResponseCode.WITHDRAWAL_REJECTED)
  @ApiOperation({
    summary: 'Turn down a payout request',
    description: 'Releases the reservation and returns the money to the driver’s spendable balance.',
  })
  @ApiSuccessResponse({ code: ResponseCode.WITHDRAWAL_REJECTED, type: AdminWithdrawalDetailDto })
  @ApiErrorResponses(
    { status: 404, code: ResponseCode.WITHDRAWAL_NOT_FOUND },
    { status: 409, code: ResponseCode.CONFLICT },
  )
  reject(
    @CurrentUser('userId') userId: string,
    @Param() params: IdParamDto,
    @Body() dto: AdminReasonDto,
  ): Promise<AdminWithdrawalDetailDto> {
    return this.finance.rejectWithdrawal(userId, params.id, dto);
  }

  @Post('withdrawals/:id/settle')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('finance.withdrawals.settle')
  @ResponseCodeMeta(ResponseCode.WITHDRAWAL_SETTLED)
  @ApiOperation({
    summary: 'Record that the transfer happened',
    description:
      'The only call that takes money out of a wallet, and the only one that marks a payout successful. It requires the bank’s reference for the transfer — a settlement that cannot be traced to a real transaction is indistinguishable from a mistake six months later.',
  })
  @ApiSuccessResponse({ code: ResponseCode.WITHDRAWAL_SETTLED, type: AdminWithdrawalDetailDto })
  @ApiErrorResponses(
    { status: 400, code: ResponseCode.VALIDATION_ERROR },
    { status: 404, code: ResponseCode.WITHDRAWAL_NOT_FOUND },
    { status: 409, code: ResponseCode.CONFLICT, description: 'Only an approved or processing payout can settle.' },
  )
  settle(
    @CurrentUser('userId') userId: string,
    @Param() params: IdParamDto,
    @Body() dto: AdminSettleWithdrawalDto,
  ): Promise<AdminWithdrawalDetailDto> {
    return this.finance.settleWithdrawal(userId, params.id, dto);
  }

  @Post('withdrawals/:id/fail')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('finance.withdrawals.settle')
  @ResponseCodeMeta(ResponseCode.WITHDRAWAL_FAILED)
  @ApiOperation({
    summary: 'Record that the transfer did not go through',
    description: 'The reservation is released and the driver gets the money back to request again.',
  })
  @ApiSuccessResponse({ code: ResponseCode.WITHDRAWAL_FAILED, type: AdminWithdrawalDetailDto })
  @ApiErrorResponses(
    { status: 404, code: ResponseCode.WITHDRAWAL_NOT_FOUND },
    { status: 409, code: ResponseCode.CONFLICT },
  )
  fail(
    @CurrentUser('userId') userId: string,
    @Param() params: IdParamDto,
    @Body() dto: AdminReasonDto,
  ): Promise<AdminWithdrawalDetailDto> {
    return this.finance.failWithdrawal(userId, params.id, dto);
  }

  // ── Ledgers ────────────────────────────────────────────────────────────

  @Get('earnings')
  @RequirePermissions('finance.view')
  @ResponseCodeMeta(ResponseCode.EARNINGS_FETCHED)
  @ApiOperation({
    summary: 'Driver earnings',
    description:
      'One immutable row per completed delivery, carrying the commission rate that was applied at the time.',
  })
  @ApiPaginatedResponse({ code: ResponseCode.EARNINGS_FETCHED, type: AdminEarningRowDto })
  findEarnings(@Query() query: AdminEarningQueryDto): Promise<PaginatedResult<AdminEarningRowDto>> {
    return this.finance.findEarnings(query);
  }

  @Get('payments')
  @RequirePermissions('finance.view')
  @ResponseCodeMeta(ResponseCode.PAYMENTS_FETCHED)
  @ApiOperation({
    summary: 'Customer payments',
    description: 'Searchable by booking code or provider reference — the starting point for a payment dispute.',
  })
  @ApiPaginatedResponse({ code: ResponseCode.PAYMENTS_FETCHED, type: AdminPaymentRowDto })
  findPayments(@Query() query: AdminPaymentQueryDto): Promise<PaginatedResult<AdminPaymentRowDto>> {
    return this.finance.findPayments(query);
  }

  @Get('drivers/:id/wallet')
  @RequirePermissions('finance.view')
  @ResponseCodeMeta(ResponseCode.WALLET_TRANSACTIONS_FETCHED)
  @ApiOperation({
    summary: 'A driver’s wallet statement',
    description:
      'The ledger, newest first. Every balance change on the platform appears here — the balance is a projection of these rows, never set on its own.',
  })
  @ApiPaginatedResponse({
    code: ResponseCode.WALLET_TRANSACTIONS_FETCHED,
    type: AdminWalletTransactionDto,
  })
  @ApiErrorResponses({ status: 404, code: ResponseCode.DRIVER_NOT_FOUND })
  walletTransactions(
    @Param() params: IdParamDto,
    @Query() query: AdminWalletTransactionQueryDto,
  ): Promise<PaginatedResult<AdminWalletTransactionDto>> {
    return this.finance.walletTransactions(params.id, query);
  }

  @Post('drivers/:id/wallet/adjust')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('finance.adjust')
  @ResponseCodeMeta(ResponseCode.WALLET_ADJUSTED)
  @ApiOperation({
    summary: 'Credit or debit a wallet by hand',
    description:
      'For goodwill and corrections. Written through the ledger like any other movement, with the reason on the driver’s statement — the balance is never edited directly. A debit cannot take a wallet below zero or spend reserved funds.',
  })
  @ApiSuccessResponse({
    status: 201,
    code: ResponseCode.WALLET_ADJUSTED,
    type: AdminWalletTransactionDto,
  })
  @ApiErrorResponses(
    { status: 400, code: ResponseCode.VALIDATION_ERROR },
    { status: 404, code: ResponseCode.DRIVER_NOT_FOUND },
    { status: 422, code: ResponseCode.INSUFFICIENT_BALANCE },
  )
  adjustWallet(
    @CurrentUser('userId') userId: string,
    @Param() params: IdParamDto,
    @Body() dto: AdminWalletAdjustmentDto,
  ): Promise<AdminWalletTransactionDto> {
    return this.finance.adjustWallet(userId, params.id, dto);
  }
}
