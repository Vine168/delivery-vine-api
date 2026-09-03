import type { CursorMetaDto, PageMetaDto } from '../dto/api-response.dto.js';

/**
 * Services return this shape; the response interceptor lifts `meta` into the
 * envelope and leaves `items` as `data`. Controllers never build envelopes.
 */
export interface PaginatedResult<T> {
  items: T[];
  meta: PageMetaDto;
}

export interface CursorPaginatedResult<T> {
  items: T[];
  meta: CursorMetaDto;
}

export function isPaginatedResult<T>(value: unknown): value is PaginatedResult<T> | CursorPaginatedResult<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { items?: unknown }).items) &&
    typeof (value as { meta?: unknown }).meta === 'object' &&
    (value as { meta?: unknown }).meta !== null
  );
}
