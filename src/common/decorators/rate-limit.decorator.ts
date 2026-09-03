import { SetMetadata } from '@nestjs/common';
import { METADATA_KEY } from '../constants/app.constants.js';

export interface RateLimitOptions {
  /** Bucket name — requests sharing a bucket share a budget. */
  bucket: string;
  limit: number;
  windowSeconds: number;
  /** Key the budget by the authenticated user instead of the client IP. */
  by?: 'ip' | 'user' | 'ip+user';
}

/** Applies a Redis sliding-window budget to a route. */
export const RateLimit = (options: RateLimitOptions) => SetMetadata(METADATA_KEY.RATE_LIMIT, options);
