import type { INestApplication } from '@nestjs/common';
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
  ['Tracking', 'Live delivery tracking.'],
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

export function setupSwagger(app: INestApplication, apiPrefix: string): void {
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
  });

  addUniversalResponses(document);

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
