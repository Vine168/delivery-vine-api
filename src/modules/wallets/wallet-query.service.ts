import { Injectable } from '@nestjs/common';
import { PaginationUtil } from '../../common/utils/pagination.util.js';
import type { CursorPaginatedResult } from '../../common/interfaces/paginated.interface.js';
import { PrismaService } from '../../database/prisma.service.js';
import { WalletService } from './wallet.service.js';
import type { WalletDto, WalletTransactionDto, WalletTransactionQueryDto } from './dto/wallet.dto.js';

/** Read side of the wallet, kept apart from the code that moves money. */
@Injectable()
export class WalletQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallets: WalletService,
  ) {}

  async findWallets(userId: string): Promise<WalletDto[]> {
    const wallets = await this.wallets.findAll(userId);

    return wallets.map((wallet) => ({
      id: wallet.id,
      currency: wallet.currency,
      balance: wallet.balance,
      reservedBalance: wallet.reservedBalance,
      availableBalance: this.wallets.availableOf(wallet),
      amountOwed: this.wallets.owedOf(wallet),
      updatedAt: wallet.updatedAt.toISOString(),
    }));
  }

  async findTransactions(
    userId: string,
    query: WalletTransactionQueryDto,
  ): Promise<CursorPaginatedResult<WalletTransactionDto>> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId_currency: { userId, currency: query.currency } },
      select: { id: true },
    });

    if (!wallet) {
      return { items: [], meta: { nextCursor: null, hasMore: false, limit: query.limit } };
    }

    // One extra row is fetched purely to answer "is there more?".
    const rows = await this.prisma.walletTransaction.findMany({
      where: { walletId: wallet.id, ...(query.type ? { type: query.type } : {}) },
      orderBy: { createdAt: 'desc' },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        type: true,
        direction: true,
        status: true,
        amount: true,
        currency: true,
        balanceBefore: true,
        balanceAfter: true,
        referenceType: true,
        referenceId: true,
        description: true,
        createdAt: true,
      },
    });

    const page = PaginationUtil.cursorPage(rows, query.limit);

    return {
      items: page.items.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      meta: page.meta,
    };
  }
}
