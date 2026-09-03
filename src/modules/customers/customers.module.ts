import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module.js';
import { CustomerProfileController } from './customer-profile.controller.js';
import { CustomerProfileService } from './customer-profile.service.js';

@Module({
  imports: [UsersModule],
  controllers: [CustomerProfileController],
  providers: [CustomerProfileService],
  exports: [CustomerProfileService],
})
export class CustomersModule {}
