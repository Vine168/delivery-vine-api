import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { REQUEST_ID_HEADER } from '../constants/app.constants.js';
import { ResponseCode, messageForCode } from '../constants/response-codes.js';
import { RequestContextStore } from '../context/request-context.js';
import { AppException, type FieldError } from '../exceptions/app.exception.js';
import { translatePrismaError } from '../../database/prisma-exception.util.js';

interface ErrorEnvelope {
  success: false;
  code: string;
  message: string;
  errors: FieldError[] | null;
  timestamp: string;
  path: string;
  requestId?: string;
}

/**
 * The single exit point for every error. Guarantees that clients only ever see
 * the documented error envelope, that internal details never leak, and that
 * 5xx errors are logged with their stack while 4xx errors are not (they are
 * normal traffic, not incidents).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    // WebSocket errors are handled by WsExceptionFilter on the gateway, which
    // runs ahead of Nest's own handler and speaks the same envelope.
    if (host.getType() !== 'http') {
      this.logger.error(`Unhandled ${host.getType()} exception: ${String(exception)}`);
      return;
    }

    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    const normalised = this.normalise(exception);
    const { status, code, message, errors, retryAfterSeconds } = normalised;

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        {
          err: exception,
          requestId: RequestContextStore.requestId(),
          method: request.method,
          path: request.originalUrl,
          userId: RequestContextStore.get()?.userId,
        },
        `Unhandled ${status} on ${request.method} ${request.originalUrl}`,
      );
    } else {
      this.logger.debug(
        `${status} ${code} on ${request.method} ${request.originalUrl}`,
      );
    }

    if (retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', String(retryAfterSeconds));
    }

    const body: ErrorEnvelope = {
      success: false,
      code,
      message,
      errors,
      timestamp: new Date().toISOString(),
      path: request.originalUrl,
      requestId: (response.getHeader(REQUEST_ID_HEADER) as string) ?? RequestContextStore.requestId(),
    };

    response.status(status).json(body);
  }

  private normalise(exception: unknown): {
    status: number;
    code: string;
    message: string;
    errors: FieldError[] | null;
    retryAfterSeconds?: number;
  } {
    if (exception instanceof AppException) {
      const payload = exception.getPayload();
      return {
        status: exception.getStatus(),
        code: payload.code,
        message: payload.message,
        errors: payload.errors,
        retryAfterSeconds: exception.retryAfterSeconds,
      };
    }

    const prismaMapped = translatePrismaError(exception);
    if (prismaMapped) {
      const payload = prismaMapped.getPayload();
      return {
        status: prismaMapped.getStatus(),
        code: payload.code,
        message: payload.message,
        errors: payload.errors,
      };
    }

    if (exception instanceof HttpException) {
      return this.fromHttpException(exception);
    }

    const bodyParserError = this.fromBodyParser(exception);
    if (bodyParserError) return bodyParserError;

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ResponseCode.INTERNAL_ERROR,
      message: messageForCode(ResponseCode.INTERNAL_ERROR),
      errors: null,
    };
  }

  /**
   * body-parser rejects an oversized or malformed payload with a plain Error
   * carrying a status, not an HttpException — so without this a client sending
   * 2 MB of JSON got a 500 and no idea what they did wrong.
   */
  private fromBodyParser(exception: unknown): {
    status: number;
    code: string;
    message: string;
    errors: FieldError[] | null;
  } | null {
    if (typeof exception !== 'object' || exception === null) return null;

    const candidate = exception as { type?: string; status?: number; statusCode?: number };
    const status = candidate.status ?? candidate.statusCode;

    if (typeof status !== 'number' || status < 400 || status >= 500) return null;

    switch (candidate.type) {
      case 'entity.too.large':
        return {
          status: HttpStatus.PAYLOAD_TOO_LARGE,
          code: ResponseCode.PAYLOAD_TOO_LARGE,
          message: 'The request body is too large.',
          errors: null,
        };
      case 'entity.parse.failed':
        return {
          status: HttpStatus.BAD_REQUEST,
          code: ResponseCode.VALIDATION_ERROR,
          message: 'The request body is not valid JSON.',
          errors: null,
        };
      case 'encoding.unsupported':
        return {
          status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
          code: ResponseCode.UNSUPPORTED_MEDIA_TYPE,
          message: 'That content encoding is not supported.',
          errors: null,
        };
      default:
        return {
          status,
          code: this.codeForStatus(status),
          message: 'The request could not be read.',
          errors: null,
        };
    }
  }

  private fromHttpException(exception: HttpException): {
    status: number;
    code: string;
    message: string;
    errors: FieldError[] | null;
  } {
    const status = exception.getStatus();
    const response = exception.getResponse();

    let message = exception.message;
    if (typeof response === 'object' && response !== null) {
      const maybeMessage = (response as { message?: unknown }).message;
      if (typeof maybeMessage === 'string') message = maybeMessage;
    }

    // Nest wraps a JSON syntax error before this filter sees it, and the
    // parser's message quotes the offending payload — and its own internals —
    // back at the caller. V8 phrases these several ways, so match the subject
    // rather than the wording. Real validation failures never reach here: they
    // arrive as AppException with a field list.
    if (status === HttpStatus.BAD_REQUEST && /JSON/i.test(message)) {
      return {
        status,
        code: ResponseCode.VALIDATION_ERROR,
        message: 'The request body is not valid JSON.',
        errors: null,
      };
    }

    return {
      status,
      code: this.codeForStatus(status),
      message: status >= HttpStatus.INTERNAL_SERVER_ERROR ? messageForCode(ResponseCode.INTERNAL_ERROR) : message,
      errors: null,
    };
  }

  private codeForStatus(status: number): ResponseCode {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return ResponseCode.VALIDATION_ERROR;
      case HttpStatus.UNAUTHORIZED:
        return ResponseCode.UNAUTHORIZED;
      case HttpStatus.FORBIDDEN:
        return ResponseCode.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ResponseCode.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ResponseCode.CONFLICT;
      case HttpStatus.PAYLOAD_TOO_LARGE:
        return ResponseCode.PAYLOAD_TOO_LARGE;
      case HttpStatus.UNSUPPORTED_MEDIA_TYPE:
        return ResponseCode.UNSUPPORTED_MEDIA_TYPE;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ResponseCode.RATE_LIMIT_EXCEEDED;
      case HttpStatus.SERVICE_UNAVAILABLE:
        return ResponseCode.SERVICE_UNAVAILABLE;
      default:
        return status >= 500 ? ResponseCode.INTERNAL_ERROR : ResponseCode.VALIDATION_ERROR;
    }
  }
}
