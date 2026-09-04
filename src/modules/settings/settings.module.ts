import { Global, Module } from '@nestjs/common';
import { SettingsService } from './settings.service.js';

/**
 * Global because the settings it holds are read by matching, payouts and the
 * back office alike — a setting nobody reads does not belong in the catalogue.
 */
@Global()
@Module({
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
