import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { PAGINATION } from '../constants/app.constants.js';

/** Offset pagination — for ordinary lists the user scrolls a few pages of. */
export class PageQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: PAGINATION.DEFAULT_PAGE })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page: number = PAGINATION.DEFAULT_PAGE;

  @ApiPropertyOptional({ minimum: 1, maximum: PAGINATION.MAX_LIMIT, default: PAGINATION.DEFAULT_LIMIT })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAGINATION.MAX_LIMIT)
  @IsOptional()
  limit: number = PAGINATION.DEFAULT_LIMIT;

  get skip(): number {
    return (this.page - 1) * this.limit;
  }
}

/** Cursor pagination — for high-volume, append-only lists (messages, tracking). */
export class CursorQueryDto {
  @ApiPropertyOptional({ description: 'Opaque cursor returned by the previous page.' })
  @IsString()
  @MaxLength(64)
  @IsOptional()
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: PAGINATION.MAX_CURSOR_LIMIT, default: PAGINATION.DEFAULT_CURSOR_LIMIT })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAGINATION.MAX_CURSOR_LIMIT)
  @IsOptional()
  limit: number = PAGINATION.DEFAULT_CURSOR_LIMIT;
}

export class DateRangeQueryDto {
  @ApiPropertyOptional({ example: '2026-09-01', description: 'Inclusive lower bound (ISO date or date-time).' })
  @IsDateString()
  @IsOptional()
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-09-30', description: 'Inclusive upper bound (ISO date or date-time).' })
  @IsDateString()
  @IsOptional()
  dateTo?: string;
}

export class SortQueryDto {
  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @Transform(({ value }) => (String(value).toLowerCase() === 'asc' ? 'asc' : 'desc'))
  @IsOptional()
  sortOrder: 'asc' | 'desc' = 'desc';
}
