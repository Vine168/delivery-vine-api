import { VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import compression from 'compression';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { setupSwagger } from './bootstrap/swagger.js';
import { LIMITS } from './common/constants/app.constants.js';
import { createValidationPipe } from './common/pipes/validation.pipe.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: false,
  });

  app.useLogger(app.get(Logger));

  const config = app.get(ConfigService);
  const apiPrefix = config.get<string>('app.apiPrefix', 'api');
  const port = config.get<number>('app.port', 3000);
  const host = config.get<string>('app.host', '0.0.0.0');
  const corsOrigins = config.get<string[]>('app.corsOrigins', ['*']);

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(compression());

  // Mobile clients send JSON; uploads go through multipart with their own limit.
  app.useBodyParser('json', { limit: LIMITS.MAX_REQUEST_BODY_BYTES });
  app.useBodyParser('urlencoded', { limit: LIMITS.MAX_REQUEST_BODY_BYTES, extended: true });

  app.setGlobalPrefix(apiPrefix, { exclude: ['health', 'health/live'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(createValidationPipe());

  app.enableCors({
    origin: corsOrigins.includes('*') ? true : corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id', 'Accept-Language'],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
  });

  app.enableShutdownHooks();

  if (config.get<boolean>('app.swaggerEnabled', true)) {
    setupSwagger(app, apiPrefix);
  }

  await app.listen(port, host);

  const logger = app.get(Logger);
  logger.log(`Deliver API listening on http://${host}:${port}/${apiPrefix}`);
  logger.log(`API documentation at http://${host}:${port}/${apiPrefix}/docs`);
}

await bootstrap();
