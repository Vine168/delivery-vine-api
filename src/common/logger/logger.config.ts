import { randomUUID } from 'node:crypto';
import type { Params } from 'nestjs-pino';
import { REQUEST_ID_HEADER } from '../constants/app.constants.js';
import { RequestContextStore } from '../context/request-context.js';

/**
 * Structured JSON logs in every environment except development, where they are
 * pretty-printed. Secrets are redacted at the logger, not at each call site, so
 * a new log line can never leak a token by omission.
 */
export function buildLoggerOptions(isDevelopment: boolean, level: string): Params {
  return {
    pinoHttp: {
      level,
      genReqId: (req, res) => {
        const existing = req.headers[REQUEST_ID_HEADER];
        const id = (Array.isArray(existing) ? existing[0] : existing) || randomUUID();
        res.setHeader(REQUEST_ID_HEADER, id);
        return id;
      },
      customProps: () => {
        const context = RequestContextStore.get();
        return {
          userId: context?.userId,
          driverId: context?.driverId,
          customerId: context?.customerId,
        };
      },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.newPassword',
          'req.body.currentPassword',
          'req.body.confirmPassword',
          'req.body.code',
          'req.body.otp',
          'req.body.refreshToken',
          'req.body.verificationToken',
          'req.body.accountNumber',
          '*.passwordHash',
          '*.accessToken',
          '*.refreshToken',
          '*.codeHash',
          '*.tokenHash',
          '*.accountNumberEnc',
        ],
        censor: '[redacted]',
      },
      autoLogging: {
        ignore: (req) => req.url === '/health' || req.url === '/health/live',
      },
      customLogLevel: (_req, res, error) => {
        if (error || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      transport: isDevelopment
        ? {
            target: 'pino-pretty',
            options: { singleLine: true, colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,req,res' },
          }
        : undefined,
    },
  };
}
