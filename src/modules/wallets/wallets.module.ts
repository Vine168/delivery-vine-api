import { Global, Module } from '@nestjs/common';
import { WalletController } from './wallet.controller.js';
import { WalletQueryService } from './wallet-query.service.js';
import { WalletService } from './wallet.service.js';

/** Global: earnings, withdrawals and adjustments all move money. */
@Global()
@Module({
  controllers: [WalletController],
  providers: [WalletService, WalletQueryService],
  exports: [WalletService, WalletQueryService],
})
export class WalletsModule {}
