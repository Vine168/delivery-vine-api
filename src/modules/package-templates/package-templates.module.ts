import { Module } from '@nestjs/common';
import { PackageTemplatesController } from './package-templates.controller.js';
import { PackageTemplatesService } from './package-templates.service.js';

@Module({
  controllers: [PackageTemplatesController],
  providers: [PackageTemplatesService],
  exports: [PackageTemplatesService],
})
export class PackageTemplatesModule {}
