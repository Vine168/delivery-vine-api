import { Module } from '@nestjs/common';
import { PricingService } from './pricing.service.js';

@Module({
  providers: [PricingService],
  exports: [PricingService],
})
export class PricingModule {}
