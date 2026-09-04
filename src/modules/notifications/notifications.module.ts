import { Global, Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsListener } from './notifications.listener.js';
import { NotificationsService } from './notifications.service.js';
import { LoggingPushSender, PUSH_SENDER } from './push-sender.interface.js';

/**
 * Global so any module can notify someone.
 *
 * Swap the PUSH_SENDER provider to plug in Firebase; nothing else changes.
 */
@Global()
@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationsListener,
    { provide: PUSH_SENDER, useClass: LoggingPushSender },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
