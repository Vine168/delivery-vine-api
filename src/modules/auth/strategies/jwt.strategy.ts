import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ResponseCode } from '../../../common/constants/response-codes.js';
import { AppException } from '../../../common/exceptions/app.exception.js';
import { RequestContextStore } from '../../../common/context/request-context.js';
import type { AccessTokenPayload, AuthenticatedUser } from '../../../common/interfaces/authenticated-user.interface.js';
import { UsersService } from '../../users/users.service.js';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly users: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('jwt.accessSecret'),
      issuer: config.get<string>('jwt.issuer'),
    });
  }

  async validate(payload: AccessTokenPayload): Promise<AuthenticatedUser> {
    if (payload.typ !== 'access') {
      throw AppException.unauthorized(ResponseCode.UNAUTHORIZED);
    }

    const user = await this.users.getAuthContext(payload.sub, payload.sid);

    // Enrich the ambient context so logs and audit rows carry the actor.
    RequestContextStore.set({
      userId: user.userId,
      role: user.role,
      customerId: user.customerId,
      driverId: user.driverId,
    });

    return user;
  }
}
