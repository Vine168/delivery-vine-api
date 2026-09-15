import type { ClientApp, DriverApprovalStatus, UserRole, UserStatus } from '../../generated/prisma/enums.js';

/** What the JWT guard puts on `request.user`. Never contains secrets. */
export interface AuthenticatedUser {
  userId: string;
  role: UserRole;
  status: UserStatus;
  phone: string;
  sessionId: string;
  /**
   * The app this session signed in through. Absent for the back office, and
   * for app builds from before the apps said which they were — those are
   * treated as both.
   */
  app?: ClientApp;
  /** Set once the account has a customer profile; `customerSuspended` decides whether it may book. */
  customerId?: string;
  /**
   * True while an operator has stopped this account booking. Only meaningful
   * alongside `customerId`; the driver side is judged by `driverApprovalStatus`.
   */
  customerSuspended?: boolean;
  /**
   * Set once the account has applied to drive, whatever the outcome. Presence
   * means enrolled, not allowed: `driverApprovalStatus` decides that.
   */
  driverId?: string;
  /** Only meaningful alongside `driverId`. */
  driverApprovalStatus?: DriverApprovalStatus;
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
