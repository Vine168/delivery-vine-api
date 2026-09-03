import { Injectable, Logger } from '@nestjs/common';
import type { OtpChannel } from '../../../generated/prisma/enums.js';

export interface OtpMessage {
  identifier: string;
  channel: OtpChannel;
  code: string;
  ttlSeconds: number;
}

export interface OtpSender {
  send(message: OtpMessage): Promise<void>;
}

export const OTP_SENDER = Symbol('OTP_SENDER');

/**
 * Development sender: writes the code to the log instead of sending it.
 *
 * Swap this for a real gateway by providing another `OTP_SENDER` in
 * AuthModule — no other code changes. The SMS provider for production has not
 * been chosen yet, so no credentials are wired here.
 */
@Injectable()
export class LoggingOtpSender implements OtpSender {
  private readonly logger = new Logger('OtpSender');

  async send(message: OtpMessage): Promise<void> {
    this.logger.warn(
      `[DEV] OTP for ${message.identifier} via ${message.channel}: ${message.code} (valid ${message.ttlSeconds}s)`,
    );
  }
}
