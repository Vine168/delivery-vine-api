import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Socket } from 'socket.io';
import type {
  AccessTokenPayload,
  AuthenticatedUser,
} from '../common/interfaces/authenticated-user.interface.js';
import { UsersService } from '../modules/users/users.service.js';

/**
 * Sockets authenticate with the same access token as the REST API.
 *
 * A connection is only as trustworthy as the token that opened it, and a token
 * can be revoked mid-connection, so the principal is resolved through the same
 * cached lookup the HTTP guard uses rather than trusting the JWT alone.
 */
@Injectable()
export class WsAuthService {
  private readonly logger = new Logger(WsAuthService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly users: UsersService,
  ) {}

  /** Returns the principal, or null when the socket should be refused. */
  async authenticate(socket: Socket): Promise<AuthenticatedUser | null> {
    const token = this.extractToken(socket);
    if (!token) return null;

    try {
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: this.config.getOrThrow<string>('jwt.accessSecret'),
        issuer: this.config.get<string>('jwt.issuer'),
      });

      if (payload.typ !== 'access') return null;

      return await this.users.getAuthContext(payload.sub, payload.sid);
    } catch (error) {
      this.logger.debug(`Socket auth failed: ${String(error)}`);
      return null;
    }
  }

  /**
   * Accepts the token where each client library naturally puts it:
   * `auth.token` for socket.io clients, the Authorization header for
   * everything else, and a query parameter as a last resort.
   */
  private extractToken(socket: Socket): string | null {
    const fromAuth = socket.handshake.auth?.token;
    if (typeof fromAuth === 'string' && fromAuth.length > 0) {
      return this.stripBearer(fromAuth);
    }

    const header = socket.handshake.headers.authorization;
    if (typeof header === 'string' && header.length > 0) {
      return this.stripBearer(header);
    }

    const query = socket.handshake.query?.token;
    if (typeof query === 'string' && query.length > 0) {
      return this.stripBearer(query);
    }

    return null;
  }

  private stripBearer(value: string): string {
    return value.startsWith('Bearer ') ? value.slice(7) : value;
  }
}
