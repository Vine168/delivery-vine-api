import { type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import type { Observable } from 'rxjs';
import { METADATA_KEY } from '../constants/app.constants.js';
import { ResponseCode } from '../constants/response-codes.js';
import { AppException } from '../exceptions/app.exception.js';

/**
 * Applied globally: every route is authenticated unless it opts out with
 * `@Public()`. Defaulting to closed means a forgotten decorator leaves an
 * endpoint locked rather than open.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext): boolean | Promise<boolean> | Observable<boolean> {
    // Sockets authenticate once, at connection time, in RealtimeGateway. This
    // guard reads an HTTP request and would silently reject every WebSocket
    // message if it ran there.
    if (context.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(METADATA_KEY.IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;
    return super.canActivate(context);
  }

  handleRequest<TUser>(error: unknown, user: TUser, info: unknown): TUser {
    if (error) throw error;

    if (!user) {
      const name = (info as { name?: string } | undefined)?.name;
      if (name === 'TokenExpiredError') {
        throw AppException.unauthorized(ResponseCode.ACCESS_TOKEN_EXPIRED);
      }
      throw AppException.unauthorized(ResponseCode.UNAUTHORIZED);
    }

    return user;
  }
}
