import { VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import compression from 'compression';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { setupSwagger } from './bootstrap/swagger.js';
import { LIMITS } from './common/constants/app.constants.js';
import { createValidationPipe } from './common/pipes/validation.pipe.js';
import { loadSecretsIntoEnv } from './config/secrets.loader.js';

async function bootstrap(): Promise<void> {
  await loadSecretsIntoEnv();

  /*
   * Imported here rather than at the top of the file, and this is load-bearing.
   *
   * `ConfigModule.forRoot({ validate })` runs while the `@Module` decorator's
   * argument is evaluated — which happens when the module is imported, not
   * when the application is created. ES module imports are hoisted and fully
   * evaluated before any of this function runs, so a static import would
   * validate the environment before the secrets above had been fetched, and
   * refuse to start over variables that were about to arrive.
   */
  const { AppModule } = await import('./app.module.js');

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

  /*
   * Two helmet defaults assume TLS in front of the app, and in development
   * there is none.
   *
   * `upgrade-insecure-requests` rewrites every subresource to https. The
   * documentation page is then served over http and immediately asks for its
   * own stylesheet and scripts over https, which nothing is listening for — so
   * the page returns 200 and renders a blank screen. HSTS compounds it: the
   * browser remembers the rule for a year and applies it to every other
   * service on the same host, long after the tab is closed.
   *
   * Both stay on in production, where the app is served over https.
   */
  const isProduction = config.get<boolean>('app.isProduction', false);

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: {
        useDefaults: true,
        directives: isProduction ? {} : { upgradeInsecureRequests: null },
      },
      strictTransportSecurity: isProduction,
    }),
  );
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
    setupSwagger(app);
  }

  await app.listen(port, host);

  const logger = app.get(Logger);
  // 0.0.0.0 is where the server listens, not an address to open in a browser.
  const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  logger.log(`Deliver API listening on http://${shownHost}:${port}/${apiPrefix}`);
  logger.log(`API documentation at http://${shownHost}:${port}/swagger`);
}

await bootstrap();
