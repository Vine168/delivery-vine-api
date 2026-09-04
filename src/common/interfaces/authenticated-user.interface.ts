import type { UserRole, UserStatus } from '../../generated/prisma/enums.js';

/** What the JWT guard puts on `request.user`. Never contains secrets. */
export interface AuthenticatedUser {
  userId: string;
  role: UserRole;
  status: UserStatus;
  phone: string;
  sessionId: string;
  /** Present only for CUSTOMER accounts. */
  customerId?: string;
  /** Present only for DRIVER accounts. */
  driverId?: string;
}

export interface AccessTokenPayload {
  sub: string;
  role: UserRole;
  sid: string;
  typ: 'access';
  /**
   * Present only for back-office accounts. The dashboard reads this to decide
   * which screens to render; the API never trusts it, and re-resolves the
   * operator's permissions on every request.
   */
  permissions?: string[];
  iat?: number;
  exp?: number;
  iss?: string;
}

export interface RefreshTokenPayload {
  sub: string;
  sid: string;
  fid: string;
  jti: string;
  typ: 'refresh';
  iat?: number;
  exp?: number;
  iss?: string;
}
