import type { CursorMetaDto, PageMetaDto } from '../dto/api-response.dto.js';
import type { CursorPaginatedResult, PaginatedResult } from '../interfaces/paginated.interface.js';

export const PaginationUtil = {
  meta(page: number, limit: number, total: number): PageMetaDto {
    const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;
    return {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrevious: page > 1,
    };
  },

  paginate<T>(items: T[], page: number, limit: number, total: number): PaginatedResult<T> {
    return { items, meta: PaginationUtil.meta(page, limit, total) };
  },

  /**
   * Builds a cursor page from a query that fetched `limit + 1` rows: the extra
   * row is the "is there more" probe and is not returned to the client.
   */
  cursorPage<T extends { id: string }>(rows: T[], limit: number): CursorPaginatedResult<T> {
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const meta: CursorMetaDto = {
      nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
      hasMore,
      limit,
    };
    return { items, meta };
  },
};
