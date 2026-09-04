import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller.js';
import { AdminSessionService } from './admin-session.service.js';

/**
 * The back office.
 *
 * Access resolution, auditing and the permission guard live in
 * AdminAccessModule, which is global — this module is where the operator-facing
 * endpoints go.
 */
@Module({
  controllers: [AdminController],
  providers: [AdminSessionService],
  exports: [AdminSessionService],
})
export class AdminModule {}
