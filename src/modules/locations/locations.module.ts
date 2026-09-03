import { HttpModule } from '@nestjs/axios';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LocationsController } from './locations.controller.js';
import { LocationsService } from './locations.service.js';
import { MAP_PROVIDER } from './providers/map-provider.interface.js';
import { RoktenhMapProvider } from './providers/roktenh-map.provider.js';

/**
 * Global: pricing, matching and tracking all need distances.
 * Swapping map vendors means providing a different class for MAP_PROVIDER.
 */
@Global()
@Module({
  imports: [
    HttpModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        timeout: config.get<number>('map.timeoutMs', 8000),
        maxRedirects: 2,
      }),
    }),
  ],
  controllers: [LocationsController],
  providers: [LocationsService, RoktenhMapProvider, { provide: MAP_PROVIDER, useExisting: RoktenhMapProvider }],
  exports: [LocationsService],
})
export class LocationsModule {}
