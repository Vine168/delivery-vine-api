import { SetMetadata, applyDecorators } from '@nestjs/common';
import { METADATA_KEY } from '../constants/app.constants.js';
import type { ResponseCode as ResponseCodeType } from '../constants/response-codes.js';

/**
 * Declares the success code (and optionally the message) the response
 * interceptor should put in the envelope for this handler.
 */
export const ResponseCode = (code: ResponseCodeType, message?: string) =>
  applyDecorators(
    SetMetadata(METADATA_KEY.RESPONSE_CODE, code),
    ...(message ? [SetMetadata(METADATA_KEY.RESPONSE_MESSAGE, message)] : []),
  );
