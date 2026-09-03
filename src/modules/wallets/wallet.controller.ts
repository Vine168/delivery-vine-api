import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiPaginatedResponse, ApiSuccessResponse } from '../../common/decorators/api-docs.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { ResponseCode as ResponseCodeMeta } from '../../common/decorators/response-code.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import type { CursorPaginatedResult } from '../../common/interfaces/paginated.interface.js';
import { UserRole } from '../../generated/prisma/enums.js';
import { WalletDto, WalletTransactionDto, WalletTransactionQueryDto } from './dto/wallet.dto.js';
import { WalletQueryService } from './wallet-query.service.js';

@ApiTags('Driver Wallet')
@ApiBearerAuth()
@Roles(UserRole.DRIVER)
@Controller({ path: 'mobile/driver/wallet', version: '1' })
export class WalletController {
  constructor(private readonly wallets: WalletQueryService) {}

  @Get()
  @ResponseCodeMeta(ResponseCode.WALLET_FETCHED)
  @ApiOperation({
    summary: 'Wallet balances',
    description:
      'One wallet per currency. `availableBalance` is what can actually be withdrawn — the balance minus anything already committed to a pending withdrawal.',
  })
  @ApiSuccessResponse({ code: ResponseCode.WALLET_FETCHED, type: WalletDto, isArray: true })
  find(@CurrentUser('userId') userId: string): Promise<WalletDto[]> {
    return this.wallets.findWallets(userId);
  }

  @Get('transactions')
  @ResponseCodeMeta(ResponseCode.WALLET_TRANSACTIONS_FETCHED)
  @ApiOperation({
    summary: 'The wallet ledger',
    description:
      'Every balance change, newest first, each carrying the balance before and after. Cursor paginated because this list only grows.',
  })
  @ApiPaginatedResponse({ code: ResponseCode.WALLET_TRANSACTIONS_FETCHED, type: WalletTransactionDto, cursor: true })
  findTransactions(
    @CurrentUser('userId') userId: string,
    @Query() query: WalletTransactionQueryDto,
  ): Promise<CursorPaginatedResult<WalletTransactionDto>> {
    return this.wallets.findTransactions(userId, query);
  }
}
