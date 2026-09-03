import {
  type CallHandler,
  type ExecutionContext,
  HttpStatus,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { map, type Observable } from 'rxjs';
import { METADATA_KEY } from '../constants/app.constants.js';
import { ResponseCode, messageForCode } from '../constants/response-codes.js';
import { isPaginatedResult } from '../interfaces/paginated.interface.js';

interface Envelope {
  success: true;
  code: string;
  message: string;
  data: unknown;
  meta: unknown;
}

/**
 * Wraps every successful handler result in the single response envelope, so no
 * controller ever hand-builds one.
 *
 * The code comes from `@ResponseCode(...)` on the handler; without it we fall
 * back to a sensible default for the HTTP method. Handlers that return a
 * `PaginatedResult` get its `meta` lifted into the envelope automatically.
 */
@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<Envelope | unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const handlerCode = this.reflector.getAllAndOverride<ResponseCode | undefined>(METADATA_KEY.RESPONSE_CODE, [
      context.getHandler(),
      context.getClass(),
    ]);
    const handlerMessage = this.reflector.getAllAndOverride<string | undefined>(METADATA_KEY.RESPONSE_MESSAGE, [
      context.getHandler(),
      context.getClass(),
    ]);

    const response = context.switchToHttp().getResponse<Response>();

    return next.handle().pipe(
      map((payload: unknown) => {
        // 204 responses must not carry a body.
        if (response.statusCode === HttpStatus.NO_CONTENT || payload === undefined) {
          return payload;
        }

        const code = handlerCode ?? this.defaultCode(response.statusCode, context);
        const envelope: Envelope = {
          success: true,
          code,
          message: handlerMessage ?? messageForCode(code),
          data: null,
          meta: null,
        };

        if (isPaginatedResult(payload)) {
          envelope.data = payload.items;
          envelope.meta = payload.meta;
        } else {
          envelope.data = payload;
        }

        return envelope;
      }),
    );
  }

  private defaultCode(statusCode: number, context: ExecutionContext): ResponseCode {
    if (statusCode === HttpStatus.CREATED) return ResponseCode.CREATED;

    const method = context.switchToHttp().getRequest<{ method: string }>().method;
    switch (method) {
      case 'GET':
        return ResponseCode.FETCHED;
      case 'POST':
        return ResponseCode.SUCCESS;
      case 'PUT':
      case 'PATCH':
        return ResponseCode.UPDATED;
      case 'DELETE':
        return ResponseCode.DELETED;
      default:
        return ResponseCode.SUCCESS;
    }
  }
}
