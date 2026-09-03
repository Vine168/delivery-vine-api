import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtStrategy } from './strategies/jwt.strategy.js';
import { OtpService } from './services/otp.service.js';
import { LoggingOtpSender, OTP_SENDER } from './services/otp-sender.interface.js';
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
    { provide: OTP_SENDER, useClass: LoggingOtpSender },
  ],
  exports: [AuthService, TokenService, OtpService, PasswordService],
})
export class AuthModule {}
