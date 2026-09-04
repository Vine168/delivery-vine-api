import { Module } from '@nestjs/common';
import { FavoriteDriversController } from './favorite-drivers.controller.js';
import { FavoriteDriversService } from './favorite-drivers.service.js';

@Module({
  controllers: [FavoriteDriversController],
  providers: [FavoriteDriversService],
  exports: [FavoriteDriversService],
})
export class FavoriteDriversModule {}
