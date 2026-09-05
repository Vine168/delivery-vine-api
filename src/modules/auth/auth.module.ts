import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtStrategy } from './strategies/jwt.strategy.js';
import { OtpService } from './services/otp.service.js';
import { LoggingOtpSender, OTP_SENDER } from './services/otp-sender.interface.js';
import { PlasGateOtpSender } from './services/plasgate-otp-sender.js';
import { PasswordService } from './services/password.service.js';
import { TokenService } from './services/token.service.js';

@Module({
  imports: [PassportModule.register({ defaultStrategy: 'jwt', session: false }), JwtModule.register({}), UsersModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    OtpService,
    PasswordService,
    JwtStrategy,
    // Swap this provider to plug in a real SMS gateway.
    {
      // A real gateway when it is configured, the log when it is not. The
      // decision is made once here rather than checked on every send, so a
      // half-configured deployment fails loudly at boot instead of silently
      // dropping codes at runtime.
      provide: OTP_SENDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        PlasGateOtpSender.isConfigured(config) ? new PlasGateOtpSender(config) : new LoggingOtpSender(),
    },
  ],
  exports: [AuthService, TokenService, OtpService, PasswordService],
})
export class AuthModule {}
