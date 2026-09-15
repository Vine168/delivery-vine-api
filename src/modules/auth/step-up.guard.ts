import { type CanActivate, type ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { METADATA_KEY } from '../../common/constants/app.constants.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface.js';
import { StepUpService } from './services/step-up.service.js';

/** Where the confirmation travels. Express lower-cases header names. */
const STEP_UP_HEADER = 'x-step-up-token';

/**
 * Asks for the password again before a money action.
 *
 * One password now opens the driver wallet as well as the customer app, so a
 * signed-in session — a phone left unlocked, a token lifted from one — must
 * not be enough on its own to redirect or drain a payout. Routes opt in with
 * `@RequiresStepUp()`; the confirmation comes from POST /auth/step-up.
 *
 * Refusals are 403, never 401: the session is fine, and most apps answer a
 * 401 by signing the person out.
 */
@Injectable()
export class StepUpGuard implements CanActivate {
  private readonly logger = new Logger(StepUpGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly stepUps: StepUpService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // HTTP only: nothing on the socket moves money.
    if (context.getType() !== 'http') return true;

    const required = this.reflector.getAllAndOverride<boolean | undefined>(METADATA_KEY.STEP_UP, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const user = request.user;
    if (!user) throw AppException.unauthorized();

    const header = request.headers[STEP_UP_HEADER];
    const token = Array.isArray(header) ? header[0] : header;

    if (!token) {
      // Builds from before step-up do not know to ask for the password.
      // Refusing them would stop every payout the day this ships, so they are
      // let through and logged until AUTH_STEP_UP_REQUIRED is turned on.
      if (this.config.get<boolean>('auth.requireStepUp', false)) {
        throw AppException.forbidden(ResponseCode.STEP_UP_REQUIRED);
      }

      this.logger.warn(`Money action without a password confirmation on session ${user.sessionId}`);
      return true;
    }

    if (!(await this.stepUps.verify(user.sessionId, token))) {
      throw AppException.forbidden(ResponseCode.STEP_UP_REQUIRED);
    }

    return true;
  }
}
