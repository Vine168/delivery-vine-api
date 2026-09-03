import { type Type, applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';
import { ApiErrorDto, CursorMetaDto, PageMetaDto } from '../dto/api-response.dto.js';
import { type ResponseCode, messageForCode, successMessageForCode } from '../constants/response-codes.js';

interface SuccessDocOptions<T> {
  status?: number;
  description?: string;
  code: ResponseCode;
  type?: Type<T>;
  isArray?: boolean;
}

/** Documents a handler's success envelope with the real code and message. */
export function ApiSuccessResponse<T>(options: SuccessDocOptions<T>) {
  const { status = 200, code, type, isArray = false, description } = options;
  const dataSchema = type
    ? isArray
      ? { type: 'array', items: { $ref: getSchemaPath(type) } }
      : { $ref: getSchemaPath(type) }
    : { type: 'object', nullable: true };

  return applyDecorators(
    ...(type ? [ApiExtraModels(type)] : []),
    ApiResponse({
      status,
      description: description ?? successMessageForCode(code),
      schema: {
        properties: {
          success: { type: 'boolean', example: true },
          code: { type: 'string', example: code },
          message: { type: 'string', example: successMessageForCode(code) },
          data: dataSchema,
          meta: { type: 'object', nullable: true, example: null },
        },
      },
    }),
  );
}

/** Documents a paginated success envelope (`data` is the array, `meta` the page info). */
export function ApiPaginatedResponse<T>(options: { code: ResponseCode; type: Type<T>; cursor?: boolean }) {
  const { code, type, cursor = false } = options;

  return applyDecorators(
    ApiExtraModels(type, cursor ? CursorMetaDto : PageMetaDto),
    ApiResponse({
      status: 200,
      description: successMessageForCode(code),
      schema: {
        properties: {
          success: { type: 'boolean', example: true },
          code: { type: 'string', example: code },
          message: { type: 'string', example: successMessageForCode(code) },
          data: { type: 'array', items: { $ref: getSchemaPath(type) } },
          meta: { $ref: getSchemaPath(cursor ? CursorMetaDto : PageMetaDto) },
        },
      },
    }),
  );
}

interface ErrorDoc {
  status: number;
  code: ResponseCode;
  description?: string;
}

/** Documents the specific failures a handler can produce, with their codes. */
export function ApiErrorResponses(...errors: ErrorDoc[]) {
  return applyDecorators(
    ApiExtraModels(ApiErrorDto),
    ...errors.map(({ status, code, description }) =>
      ApiResponse({
        status,
        description: description ?? successMessageForCode(code),
        schema: {
          properties: {
            success: { type: 'boolean', example: false },
            code: { type: 'string', example: code },
            message: { type: 'string', example: messageForCode(code) },
            errors: { type: 'array', nullable: true, items: { type: 'object' }, example: null },
          },
        },
      }),
    ),
  );
}
