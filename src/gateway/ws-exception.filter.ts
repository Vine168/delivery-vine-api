import { type ArgumentsHost, Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { BaseWsExceptionFilter, WsException } from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { WsEvent } from '../common/constants/events.js';
import { ResponseCode, messageForCode } from '../common/constants/response-codes.js';
import { AppException, type FieldError } from '../common/exceptions/app.exception.js';

/**
 * Socket errors in the same envelope as HTTP errors.
 *
 * Nest's default handler answers every failure with a bare
 * `{"status":"error","message":"Internal server error"}`, which tells a mobile
 * client nothing and leaks the raw payload back. This filter is applied to the
 * gateway so it runs first, and gives sockets the same machine-readable `code`
 * the REST API uses.
 */
@Catch()
export class WsExceptionFilter extends BaseWsExceptionFilter {
  private readonly logger = new Logger(WsExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const socket = host.switchToWs().getClient<Socket>();
    const pattern = host.switchToWs().getPattern?.() ?? null;
    const { status, code, message, errors } = this.describe(exception);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error({ err: exception, event: pattern }, `Socket handler failed: ${message}`);
    }

    socket.emit(WsEvent.CONNECTION_ERROR, {
      success: false,
      code,
      message,
      errors,
      event: pattern,
      timestamp: new Date().toISOString(),
    });
  }

  private describe(exception: unknown): {
    status: number;
    code: string;
    message: string;
    errors: FieldError[] | null;
  } {
    if (exception instanceof AppException) {
      const payload = exception.getPayload();
      return {
        status: exception.getStatus(),
        code: payload.code,
        message: payload.message,
        errors: payload.errors,
      };
    }

    if (exception instanceof WsException) {
      return {
        status: HttpStatus.BAD_REQUEST,
        code: ResponseCode.VALIDATION_ERROR,
        message: String(exception.getError()),
        errors: null,
      };
    }

    if (exception instanceof HttpException) {
      return {
        status: exception.getStatus(),
        code:
          exception.getStatus() === HttpStatus.UNAUTHORIZED
            ? ResponseCode.UNAUTHORIZED
            : ResponseCode.VALIDATION_ERROR,
        message: exception.message,
        errors: null,
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ResponseCode.INTERNAL_ERROR,
      message: messageForCode(ResponseCode.INTERNAL_ERROR),
      errors: null,
    };
  }
}
