import { HttpException, HttpStatus } from '@nestjs/common';
import { ResponseCode, messageForCode } from '../constants/response-codes.js';

export interface FieldError {
  field: string;
  message: string;
}

export interface AppExceptionPayload {
  code: ResponseCode;
  message: string;
  errors: FieldError[] | null;
  retryAfterSeconds?: number;
}

/**
 * The only exception type services should throw.
 *
 * It carries the machine-readable `code` that mobile clients switch on, so the
 * HTTP status and the domain reason stay independent: a 409 can be
 * DELIVERY_ALREADY_ASSIGNED or WITHDRAWAL_PENDING_EXISTS, and the client can
 * tell them apart without parsing prose.
 */
export class AppException extends HttpException {
  readonly code: ResponseCode;
  readonly errors: FieldError[] | null;
  readonly retryAfterSeconds?: number;

  constructor(
    code: ResponseCode,
    status: HttpStatus,
    message?: string,
    errors: FieldError[] | null = null,
    options?: { cause?: unknown; retryAfterSeconds?: number },
  ) {
    const payload: AppExceptionPayload = {
      code,
      message: message ?? messageForCode(code),
      errors,
    };
    super(payload, status, { cause: options?.cause });
    this.code = code;
    this.errors = errors;
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }

  static badRequest(code: ResponseCode, message?: string, errors?: FieldError[] | null): AppException {
    return new AppException(code, HttpStatus.BAD_REQUEST, message, errors ?? null);
  }

  static validation(errors: FieldError[], message?: string): AppException {
    return new AppException(ResponseCode.VALIDATION_ERROR, HttpStatus.BAD_REQUEST, message, errors);
  }

  static unauthorized(code: ResponseCode = ResponseCode.UNAUTHORIZED, message?: string): AppException {
    return new AppException(code, HttpStatus.UNAUTHORIZED, message);
  }

  static forbidden(code: ResponseCode = ResponseCode.FORBIDDEN, message?: string): AppException {
    return new AppException(code, HttpStatus.FORBIDDEN, message);
  }

  static notFound(code: ResponseCode = ResponseCode.NOT_FOUND, message?: string): AppException {
    return new AppException(code, HttpStatus.NOT_FOUND, message);
  }

  static conflict(code: ResponseCode = ResponseCode.CONFLICT, message?: string): AppException {
    return new AppException(code, HttpStatus.CONFLICT, message);
  }

  /** 422 — the request was well-formed but violates a business rule. */
  static unprocessable(code: ResponseCode, message?: string, errors?: FieldError[] | null): AppException {
    return new AppException(code, HttpStatus.UNPROCESSABLE_ENTITY, message, errors ?? null);
  }

  static tooManyRequests(
    code: ResponseCode = ResponseCode.RATE_LIMIT_EXCEEDED,
    message?: string,
    retryAfterSeconds?: number,
  ): AppException {
    return new AppException(code, HttpStatus.TOO_MANY_REQUESTS, message, null, { retryAfterSeconds });
  }

  static internal(message?: string, cause?: unknown): AppException {
    return new AppException(ResponseCode.INTERNAL_ERROR, HttpStatus.INTERNAL_SERVER_ERROR, message, null, { cause });
  }

  static serviceUnavailable(code: ResponseCode = ResponseCode.SERVICE_UNAVAILABLE, message?: string): AppException {
    return new AppException(code, HttpStatus.SERVICE_UNAVAILABLE, message);
  }

  getPayload(): AppExceptionPayload {
    return this.getResponse() as AppExceptionPayload;
  }
}
