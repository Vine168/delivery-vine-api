import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller.js';
import { ChatListener } from './chat.listener.js';
import { ChatService } from './chat.service.js';

@Module({
  controllers: [ChatController],
  providers: [ChatService, ChatListener],
  exports: [ChatService],
})
export class ChatModule {}
