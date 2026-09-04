import { SetMetadata, applyDecorators } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import { METADATA_KEY } from '../constants/app.constants.js';

/**
 * Marks an endpoint as safe to retry.
 *
 * A client that sends `Idempotency-Key` gets the original response back on a
 * repeat instead of a second booking, a second charge or a second payout
 * request. Without the header the endpoint behaves exactly as before, so this
 * is additive for clients that have not adopted it yet — but every mobile
 * screen that spends money should be sending one.
 */
export const Idempotent = () =>
  applyDecorators(
    SetMetadata(METADATA_KEY.IDEMPOTENT, true),
    ApiHeader({
      name: 'Idempotency-Key',
      required: false,
      description:
        'A value unique to this attempt — a UUID generated when the screen opens, not per tap. Retrying with the same key returns the original result rather than repeating the action. Reusing a key with a different body is refused.',
      schema: { type: 'string', maxLength: 128, example: '7f2a1c4e-9b3d-4a51-8c76-2e0f5d8a1b93' },
    }),
  );
