import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { appConfig } from './app.config.js';
import { databaseConfig } from './database.config.js';
import { deliveryConfig } from './delivery.config.js';
import { validateEnv } from './env.validation.js';
import { jwtConfig } from './jwt.config.js';
import { mapConfig } from './map.config.js';
import { otpConfig } from './otp.config.js';
import { redisConfig } from './redis.config.js';
import { storageConfig } from './storage.config.js';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      expandVariables: true,
      envFilePath: ['.env.local', '.env'],
      validate: validateEnv,
      load: [
        appConfig,
        databaseConfig,
        jwtConfig,
        redisConfig,
        storageConfig,
        mapConfig,
        otpConfig,
        deliveryConfig,
      ],
    }),
  ],
})
export class AppConfigModule {}
