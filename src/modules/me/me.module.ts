import { Module } from '@nestjs/common';
import { DriversModule } from '../drivers/drivers.module.js';
import { MeController } from './me.controller.js';
import { MeService } from './me.service.js';

/** Its own module so neither profile module has to depend on the other. */
@Module({
  imports: [DriversModule],
  controllers: [MeController],
  providers: [MeService],
})
export class MeModule {}
