import { Module } from '@nestjs/common';
import { PromoCodesController } from './promo-codes.controller.js';
import { PromoCodesService } from './promo-codes.service.js';

@Module({
  controllers: [PromoCodesController],
  providers: [PromoCodesService],
  exports: [PromoCodesService],
})
export class PromoCodesModule {}
