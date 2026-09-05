import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CryptoUtil } from '../common/utils/crypto.util.js';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { ApiErrorDto, ApiSuccessDto, CursorMetaDto, PageMetaDto } from '../common/dto/api-response.dto.js';

export const SWAGGER_TAGS = [
  ['Authentication', 'Registration, OTP, sign-in, token rotation and password recovery.'],
  ['Customer Profile', 'The signed-in customer account and avatar.'],
  ['Customer Address', 'Saved pickup and drop-off addresses.'],
  ['Customer Delivery', 'Quoting, booking, tracking and cancelling deliveries.'],
  ['Locations', 'Place search, reverse geocoding and route estimates.'],
  ['Promotions', 'Promo code validation.'],
  ['Payments', 'Payment methods and delivery payments.'],
  ['Rating', 'Rating a completed delivery.'],
  ['Driver Profile', 'The signed-in driver account, vehicle and documents.'],
  ['Driver Availability', 'Going online and offline, and location reporting.'],
  ['Driver Job', 'Job offers, acceptance and the delivery execution flow.'],
  ['Driver Earnings', 'Earnings summaries and history.'],
  ['Driver Wallet', 'Wallet balance, ledger and withdrawals.'],
  ['Messages', 'Customer and driver conversations.'],
  ['Notifications', 'In-app notifications and push device registration.'],
  ['Uploads', 'File upload and signed download URLs.'],
  ['Health', 'Liveness and readiness probes.'],

  // ── Back office ──
  ['Admin', 'The signed-in operator and the permission catalogue.'],
  ['Admin — Dashboard', 'The operations overview: volumes, revenue, fleet and queues.'],
  ['Admin — Deliveries', 'Every delivery, the live map, and support actions on them.'],
  ['Admin — Drivers', 'Approval, documents, suspension and zone assignment.'],
  ['Admin — Customers', 'Customer accounts and suspension.'],
  ['Admin — Finance', 'Revenue, payouts, earnings, payments and wallet adjustments.'],
  ['Admin — Pricing', 'Vehicle types and pricing rules.'],
  ['Admin — Zones', 'Service zones.'],
  ['Admin — Promo codes', 'Discount campaigns.'],
  ['Admin — Notifications', 'Broadcasts, audiences and what was sent.'],
  ['Admin — Roles', 'Permission bundles.'],
  ['Admin — Administrators', 'Back-office accounts.'],
  ['Admin — Settings', 'Runtime settings an operator may change.'],
  ['Admin — Audit log', 'What operators have done.'],
] as const;

/**
 * The OpenAPI document itself.
 *
 * Separate from serving it so `npm run swagger:export` can write the spec to
 * a file — for client generation, a Postman import, or diffing the API
 * surface in CI — without booting an HTTP listener.
 */
export function buildOpenApiDocument(app: INestApplication, apiPrefix: string): OpenAPIObject {
  const builder = new DocumentBuilder()
    .setTitle('Deliver API')
    .setDescription(
      [
        'REST API for the Deliver platform — customer app, driver app and back office.',
        '',
        '### Response envelope',
        'Every response uses the same shape:',
        '```json',
        '{ "success": true, "code": "DELIVERY_CREATED", "message": "...", "data": {}, "meta": null }',
        '```',
        'Errors use `success: false` with `code` and an optional `errors` array. Clients should branch on',
        '`code`, never on `message`.',
        '',
        '### Money',
        'Amounts are integers in the currency minor unit and always travel with their currency:',
        '`{ "amount": 45000, "currency": "KHR" }` is 45,000 riel. The server is the only authority on price.',
        '',
        '### Authentication',
        'Bearer access tokens (15 min) with single-use refresh tokens (30 days). One phone number may hold a',
        'customer account, a driver account and a back-office account independently, so `POST /auth/login`',
        'takes the role being signed in as.',
        '',
        '### Back office',
        'Endpoints under `/admin` additionally require a permission, which the operator holds through their',
        'role. `GET /admin/me` returns the permissions the signed-in operator holds, so the dashboard can',
        'decide what to render; the server re-checks them from the database on every request and never trusts',
        'the copy in the token. A refusal names what was missing — "You do not have permission to cancel',
        'deliveries." — rather than a bare 403.',
      ].join('\n'),
    )
    .setVersion('1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Access token from POST /auth/login' },
      'bearer',
    )
    .addServer(`/${apiPrefix}`);

  for (const [name, description] of SWAGGER_TAGS) {
    builder.addTag(name, description);
  }

  const document = SwaggerModule.createDocument(app, builder.build(), {
    extraModels: [ApiSuccessDto, ApiErrorDto, PageMetaDto, CursorMetaDto],
    operationIdFactory,
  });

  addUniversalResponses(document);

  return document;
}

/**
 * Names each operation for the clients generated from this document.
 *
 * Nest's default is `CustomerDeliveriesController_create_v1`, which a
 * generator turns into `customerDeliveriesControllerCreateV1()`. Dropping the
 * noise gives `customerDeliveries_create` and therefore
 * `customerDeliveriesCreate()` — the mobile teams read these constantly, and
 * the controller suffix tells them nothing.
 *
 * The version is kept only when it is not the default, so today's names stay
 * short and a future v2 cannot silently collide with its v1.
 */
function operationIdFactory(controllerKey: string, methodKey: string, version?: string): string {
  const controller = controllerKey.replace(/Controller$/, '');
  const name = `${controller.charAt(0).toLowerCase()}${controller.slice(1)}_${methodKey}`;

  // Nest hands the version through as `v1`, not `1`.
  const number = version?.replace(/^v/i, '');

  return number && number !== '1' ? `${name}_v${number}` : name;
}

/**
 * Password protection for the documentation, when credentials are configured.
 *
 * The document describes every endpoint on the platform, the back office
 * included — which routes exist, what they accept, which permission each one
 * needs. That is a map worth having before attacking something, and it was
 * readable by anyone who found the URL.
 *
 * HTTP Basic rather than a bearer token because this is a page a person opens
 * in a browser: the browser prompts, remembers, and sends the header on the
 * asset requests too. There is nothing to log into and no session to manage.
 *
 * Returns undefined when no credentials are set, leaving the docs open — which
 * is what local development wants, and which production refuses to boot with.
 */
function basicAuthGuard(app: INestApplication):
  | ((request: IncomingMessage, response: ServerResponse, next: () => void) => void)
  | undefined {
  const config = app.get(ConfigService);
  const user = config.get<string>('app.swaggerUser');
  const password = config.get<string>('app.swaggerPassword');

  if (!user || !password) return undefined;

  return (request, response, next) => {
    const header = request.headers.authorization ?? '';
    const [scheme, encoded] = header.split(' ');

    if (scheme?.toLowerCase() === 'basic' && encoded) {
      const [suppliedUser, ...rest] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
      const suppliedPassword = rest.join(':');

      // Both compared, and always both, so the time taken says nothing about
      // which half was wrong.
      const userOk = CryptoUtil.safeEqual(suppliedUser ?? '', user);
      const passwordOk = CryptoUtil.safeEqual(suppliedPassword, password);

      if (userOk && passwordOk) {
        next();
        return;
      }
    }

    // No detail about what was missing or wrong: an unauthenticated caller
    // should not learn whether the username exists.
    response.statusCode = 401;
    response.setHeader('WWW-Authenticate', 'Basic realm="Deliver API documentation", charset="UTF-8"');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ success: false, code: 'UNAUTHORIZED', message: 'Authentication is required.' }));
  };
}

/** Builds the document and serves it at `/{prefix}/docs`. */
export function setupSwagger(app: INestApplication, apiPrefix: string): void {
  const document = buildOpenApiDocument(app, apiPrefix);

  // Registered before the documentation routes, so it covers the page, the
  // static assets and the JSON document alike — the spec is the part worth
  // protecting, and serving it unguarded next to a locked page would be
  // pointless.
  const guard = basicAuthGuard(app);
  if (guard) {
    (app as unknown as { use: (path: string, handler: unknown) => void }).use(
      `/${apiPrefix}/docs`,
      guard,
    );
  }

  SwaggerModule.setup(`${apiPrefix}/docs`, app, document, {
    jsonDocumentUrl: `${apiPrefix}/docs/json`,
    swaggerOptions: {
      persistAuthorization: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
      docExpansion: 'none',
    },
  });
}

/** The error envelope, referenced rather than repeated on every operation. */
function errorResponse(code: string, message: string) {
  return {
    description: message,
    content: {
      'application/json': {
        schema: {
          properties: {
            success: { type: 'boolean', example: false },
            code: { type: 'string', example: code },
            message: { type: 'string', example: message },
            errors: { type: 'array', nullable: true, items: { type: 'object' }, example: null },
          },
        },
      },
    },
  };
}

/**
 * Adds the failures every authenticated endpoint shares.
 *
 * Documenting 401 and 403 on each handler individually would be noise that
 * drifts; adding them once here means an endpoint cannot be added without them
 * appearing, and a reader can trust that an operation listing only its own
 * errors still returns the standard ones.
 */
function addUniversalResponses(document: OpenAPIObject): void {
  type Operation = { security?: unknown[]; responses?: Record<string, unknown> };

  for (const operations of Object.values(document.paths)) {
    for (const operation of Object.values(operations) as Operation[]) {
      if (typeof operation !== 'object' || operation === null) continue;
      // Public endpoints (auth, health) declare no security requirement.
      if (!operation.security?.length) continue;

      operation.responses ??= {};
      operation.responses['401'] ??= errorResponse('UNAUTHORIZED', 'Authentication is required.');
      operation.responses['403'] ??= errorResponse(
        'ROLE_NOT_ALLOWED',
        'Your account type cannot access this resource.',
      );
      operation.responses['500'] ??= errorResponse(
        'INTERNAL_ERROR',
        'An unexpected error occurred. Please try again.',
      );
    }
  }
}
