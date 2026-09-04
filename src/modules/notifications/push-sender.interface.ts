import { Injectable, Logger } from '@nestjs/common';

export interface PushMessage {
  token: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface PushResult {
  delivered: boolean;
  providerRef?: string;
  error?: string;
  /** True when the token is dead and should stop being used. */
  tokenInvalid?: boolean;
}

export interface PushSender {
  isConfigured(): boolean;
  send(message: PushMessage): Promise<PushResult>;
}

export const PUSH_SENDER = Symbol('PUSH_SENDER');

/**
 * Development sender: records what would have been sent.
 *
 * Firebase credentials have not been provided, so rather than pretend a push
 * succeeded this reports honestly that it was not delivered. The in-app
 * notification is written either way, which is what the notification screen
 * reads — so nothing is lost by push being unconfigured.
 */
@Injectable()
export class LoggingPushSender implements PushSender {
  private readonly logger = new Logger('PushSender');

  isConfigured(): boolean {
    return false;
  }

  async send(message: PushMessage): Promise<PushResult> {
    this.logger.debug(`[DEV] push to ${message.token.slice(0, 12)}…: ${message.title} — ${message.body}`);
    return { delivered: false, error: 'Push notifications are not configured.' };
  }
}
