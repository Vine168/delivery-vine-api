import { Global, Module } from '@nestjs/common';
import { FileUrlService } from './file-url.service.js';
import { UploadsController } from './uploads.controller.js';
import { UploadsService } from './uploads.service.js';

/**
 * Global because almost every domain renders a file URL: profiles, documents,
 * packages, proof of delivery, chat.
 */
@Global()
@Module({
  controllers: [UploadsController],
  providers: [UploadsService, FileUrlService],
  exports: [UploadsService, FileUrlService],
})
export class UploadsModule {}
