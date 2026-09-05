import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { appConfig } from './app.config.js';
import { databaseConfig } from './database.config.js';
import { deliveryConfig } from './delivery.config.js';
import { validateEnv } from './env.validation.js';
import { jwtConfig } from './jwt.config.js';
import { mapConfig } from './map.config.js';
import { otpConfig } from './otp.config.js';
import { paymentConfig, payoutConfig } from './payment.config.js';
import { redisConfig } from './redis.config.js';
import { smsConfig } from './sms.config.js';
import { storageConfig } from './storage.config.js';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      expandVariables: true,
      /**
       * The test environment must not fall back to `.env`. A blank value in
       * `.env.test` does not shadow a real one in `.env` — the key is simply
       * absent — so development credentials would otherwise be picked up by
       * the test run, and a test asserting "this integration is unconfigured"
       * would quietly exercise the live one.
       */
      envFilePath: process.env.NODE_ENV === 'test' ? ['.env.test'] : ['.env.local', '.env'],
      validate: validateEnv,
      load: [
        appConfig,
        databaseConfig,
        jwtConfig,
        redisConfig,
        storageConfig,
        smsConfig,
        mapConfig,
        otpConfig,
        deliveryConfig,
        paymentConfig,
        payoutConfig,
      ],
    }),
  ],
})
export class AppConfigModule {}
