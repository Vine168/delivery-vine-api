import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { UsersModule } from '../modules/users/users.module.js';
import { RealtimeEmitter } from './realtime.emitter.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { RealtimeListener } from './realtime.listener.js';
import { WsAuthService } from './ws-auth.service.js';

/**
 * Global so any module can broadcast through RealtimeEmitter without importing
 * the gateway — which would be a cycle, since the gateway needs the services
 * it would be imported by.
 */
@Global()
@Module({
  imports: [JwtModule.register({}), UsersModule],
  providers: [RealtimeGateway, RealtimeEmitter, RealtimeListener, WsAuthService],
  exports: [RealtimeEmitter],
})
export class RealtimeModule {}
