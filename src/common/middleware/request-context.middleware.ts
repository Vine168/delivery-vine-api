import { Injectable, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { REQUEST_ID_HEADER } from '../constants/app.constants.js';
import { RequestContextStore } from '../context/request-context.js';

/**
 * Establishes the correlation id for the request and opens the async context
 * that logs, guards and services read from.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers[REQUEST_ID_HEADER];
    const requestId = (Array.isArray(incoming) ? incoming[0] : incoming) || randomUUID();

    res.setHeader(REQUEST_ID_HEADER, requestId);
    (req as Request & { requestId?: string }).requestId = requestId;

    RequestContextStore.run(
      {
        requestId,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      },
      () => next(),
    );
  }
}
