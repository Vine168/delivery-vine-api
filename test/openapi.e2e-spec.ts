import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OpenAPIObject } from '@nestjs/swagger';
import { createTestHarness, type TestHarness } from './app-harness.js';
import { buildOpenApiDocument, SWAGGER_TAGS } from '../src/bootstrap/swagger.js';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** Deliberately reachable without a token. */
const PUBLIC_PREFIXES = ['/api/v1/auth/', '/health'];

interface Operation {
  label: string;
  path: string;
  method: string;
  summary?: string;
  operationId?: string;
  tags?: string[];
  security?: unknown[];
  responses: Record<string, unknown>;
}

/**
 * The published API document, checked against the API it claims to describe.
 *
 * It is generated from the running application, so it cannot drift the way a
 * hand-written spec would — but it can still be incomplete, and an endpoint
 * with no summary or a tag nobody declared is a gap a client integrator hits
 * before anyone here notices.
 */
describe('OpenAPI document (e2e)', () => {
  let harness: TestHarness;
  let document: OpenAPIObject;
  let operations: Operation[];

  beforeAll(async () => {
    harness = await createTestHarness();
    document = buildOpenApiDocument(harness.app, 'api');

    operations = Object.entries(document.paths).flatMap(([path, item]) =>
      Object.entries(item as Record<string, Operation>)
        .filter(([method]) => (METHODS as readonly string[]).includes(method))
        .map(([method, operation]) => ({ ...operation, path, method, label: `${method.toUpperCase()} ${path}` })),
    );
  });

  afterAll(async () => {
    await harness.close();
  });

  it('describes the whole API', () => {
    expect(operations.length).toBeGreaterThan(170);
  });

  describe('every operation', () => {
    it('has a summary', () => {
      const missing = operations.filter((operation) => !operation.summary).map((o) => o.label);
      expect(missing, `no summary:\n${missing.join('\n')}`).toEqual([]);
    });

    it('is grouped under a tag the document declares', () => {
      const declared = new Set<string>(SWAGGER_TAGS.map(([name]) => name));
      const wrong = operations
        .filter((operation) => !operation.tags?.length || !operation.tags.every((tag) => declared.has(tag)))
        .map((o) => `${o.label} → ${o.tags?.join(', ') ?? 'none'}`);

      expect(wrong, `tagged with something undeclared:\n${wrong.join('\n')}`).toEqual([]);
    });

    it('documents at least one response', () => {
      const missing = operations
        .filter((operation) => Object.keys(operation.responses ?? {}).filter((c) => c !== 'default').length === 0)
        .map((o) => o.label);

      expect(missing, `no documented response:\n${missing.join('\n')}`).toEqual([]);
    });

    it('declares bearer auth unless it is deliberately public', () => {
      const missing = operations
        .filter((operation) => !PUBLIC_PREFIXES.some((prefix) => operation.path.startsWith(prefix)))
        .filter((operation) => !operation.security?.length)
        .map((o) => o.label);

      expect(missing, `protected but not marked as needing a token:\n${missing.join('\n')}`).toEqual([]);
    });
  });

  describe('operation ids', () => {
    it('are unique, so a generated client compiles', () => {
      const ids = operations.map((operation) => operation.operationId);
      const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);

      expect([...new Set(duplicates)]).toEqual([]);
    });

    it('read as a method name rather than a class name', () => {
      // `customerDeliveries_create`, not `CustomerDeliveriesController_create_v1`.
      const noisy = operations
        .filter((operation) => /Controller|_v\d+$/.test(operation.operationId ?? ''))
        .map((o) => o.operationId);

      expect(noisy, `these would generate awkward client methods:\n${noisy.join('\n')}`).toEqual([]);
    });
  });

  describe('the document itself', () => {
    it('declares no tag that nothing uses', () => {
      const used = new Set(operations.flatMap((operation) => operation.tags ?? []));
      const unused = SWAGGER_TAGS.map(([name]) => name).filter((name) => !used.has(name));

      // A tag with no operations is a section of the docs that opens empty.
      expect(unused, `declared but unused:\n${unused.join('\n')}`).toEqual([]);
    });

    it('explains the envelope, money and auth up front', () => {
      const description = document.info.description ?? '';

      expect(description).toContain('Response envelope');
      expect(description).toContain('Money');
      expect(description).toContain('minor unit');
      expect(description).toContain('Back office');
    });

    it('offers a bearer scheme a reader can actually use', () => {
      expect(document.components?.securitySchemes?.bearer).toMatchObject({
        type: 'http',
        scheme: 'bearer',
      });
    });

    it('serves paths under the API prefix, with health outside it', () => {
      const paths = Object.keys(document.paths);

      expect(paths).toContain('/health');
      // 179 operations across rather fewer paths, since many share one URL.
      expect(paths.filter((path) => path.startsWith('/api/v1/')).length).toBeGreaterThan(130);
    });
  });
});
