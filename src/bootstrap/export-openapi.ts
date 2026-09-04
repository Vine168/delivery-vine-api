import { VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { AppModule } from '../app.module.js';
import { buildOpenApiDocument } from './swagger.js';

/**
 * Writes the OpenAPI document to a file.
 *
 * The spec is generated from the running code, so it cannot drift from the
 * API the way a hand-maintained file would — but a served-only document is
 * awkward to consume: generating a client, importing a collection into
 * Postman, or diffing the API surface in review all want a file, and none of
 * them should require a database and a Redis to be up first.
 *
 * The app is created but never listens, so this is safe to run in CI.
 */
async function exportDocument(): Promise<void> {
  const output = resolve(process.argv[2] ?? 'openapi.json');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: false,
    // Matching main.ts matters: the prefix and versioning shape every path in
    // the document, so a spec built without them would describe a different API.
    bufferLogs: true,
  });

  const apiPrefix = app.get(ConfigService).get<string>('app.apiPrefix', 'api');
  app.setGlobalPrefix(apiPrefix, { exclude: ['health', 'health/live'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await app.init();

  const document = buildOpenApiDocument(app, apiPrefix);
  const operations = Object.values(document.paths).reduce(
    (total, item) =>
      total + Object.keys(item).filter((key) => ['get', 'post', 'put', 'patch', 'delete'].includes(key)).length,
    0,
  );

  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  await app.close();

  console.log(`Wrote ${operations} operations to ${output}`);
}

await exportDocument();
