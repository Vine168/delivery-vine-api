import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ResponseCode } from '../../../common/constants/response-codes.js';
import { AppException } from '../../../common/exceptions/app.exception.js';
import { OtpChannel } from '../../../generated/prisma/enums.js';
import type { OtpMessage, OtpSender } from './otp-sender.interface.js';

interface PlasGateResponse {
  queue_id?: string;
  message_count?: number;
  message?: string | Record<string, string>;
}

/**
 * Sends OTP codes over PlasGate.
 *
 * The one rule that shapes this file: the code never reaches a log line, an
 * error message or an exception. Everything here is written so that a failure
 * can be diagnosed from the provider's own reply and the recipient's number
 * without the secret ever being written down.
 *
 * A failure is raised rather than swallowed. The caller releases the resend
 * cooldown when that happens, so someone whose message did not go can ask for
 * another immediately instead of waiting out a cooldown for a code they never
 * received.
 */
@Injectable()
export class PlasGateOtpSender implements OtpSender {
  private readonly logger = new Logger('OtpSender');

  private readonly baseUrl: string;
  private readonly privateKey: string;
  private readonly secretKey: string;
  private readonly sender: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config.getOrThrow<string>('sms.baseUrl');
    this.privateKey = config.getOrThrow<string>('sms.privateKey');
    this.secretKey = config.getOrThrow<string>('sms.secretKey');
    this.sender = config.getOrThrow<string>('sms.sender');
    this.timeoutMs = config.get<number>('sms.timeoutMs', 10_000);
  }

  /** Whether the gateway is configured well enough to be used at all. */
  static isConfigured(config: ConfigService): boolean {
    return Boolean(
      config.get<string>('sms.privateKey') &&
        config.get<string>('sms.secretKey') &&
        config.get<string>('sms.sender'),
    );
  }

  async send(message: OtpMessage): Promise<void> {
    if (message.channel !== OtpChannel.SMS) {
      // Better to say so than to quietly text someone their email code.
      throw AppException.serviceUnavailable(
        ResponseCode.SERVICE_UNAVAILABLE,
        'Email verification is not available yet. Use SMS.',
      );
    }

    const url = `${this.baseUrl}?private_key=${encodeURIComponent(this.privateKey)}`;
    let response: Response;

    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Secret': this.secretKey },
        body: JSON.stringify({
          sender: this.sender,
          to: message.identifier,
          content: this.body(message),
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // Network or timeout: the message definitely did not go.
      this.logger.error(`SMS to ${this.mask(message.identifier)} failed to send: ${String(error)}`);
      throw AppException.serviceUnavailable(
        ResponseCode.SERVICE_UNAVAILABLE,
        'We could not send the verification code. Please try again.',
      );
    }

    const payload = (await response.json().catch(() => ({}))) as PlasGateResponse;

    // The gateway answers with a queue id when it has accepted the message;
    // anything else — including a 200 carrying an error object — has not been
    // sent, whatever the status code says.
    if (!response.ok || !payload.queue_id) {
      this.logger.error(
        `SMS to ${this.mask(message.identifier)} rejected (${response.status}): ${this.reason(payload)}`,
      );
      throw AppException.serviceUnavailable(
        ResponseCode.SERVICE_UNAVAILABLE,
        'We could not send the verification code. Please check the number and try again.',
      );
    }

    this.logger.log(`SMS queued for ${this.mask(message.identifier)} (${payload.queue_id})`);
  }

  private body(message: OtpMessage): string {
    const minutes = Math.max(1, Math.round(message.ttlSeconds / 60));
    return `${message.code} is your verification code. It expires in ${minutes} minute${minutes === 1 ? '' : 's'}. Do not share it with anyone.`;
  }

  /** `+85512345678` → `+8551****678`. Enough to trace, not enough to identify. */
  private mask(identifier: string): string {
    if (identifier.length <= 8) return '***';
    return `${identifier.slice(0, 5)}****${identifier.slice(-3)}`;
  }

  private reason(payload: PlasGateResponse): string {
    if (typeof payload.message === 'string') return payload.message;
    if (payload.message) return JSON.stringify(payload.message);
    return 'no reason given';
  }
}
