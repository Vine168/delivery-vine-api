import { Module } from '@nestjs/common';
import { WithdrawalsController } from './withdrawals.controller.js';
import { WithdrawalsService } from './withdrawals.service.js';

@Module({
  controllers: [WithdrawalsController],
  providers: [WithdrawalsService],
  // Exported for the admin API, which approves and settles these requests.
  exports: [WithdrawalsService],
})
export class WithdrawalsModule {}
