import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PageMetaDto {
  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 20 })
  limit: number;

  @ApiProperty({ example: 100 })
  total: number;

  @ApiProperty({ example: 5 })
  totalPages: number;

  @ApiProperty({ example: true })
  hasNext: boolean;

  @ApiProperty({ example: false })
  hasPrevious: boolean;
}

export class CursorMetaDto {
  @ApiPropertyOptional({ nullable: true, example: 'cm8x1a2b3c4d' })
  nextCursor: string | null;

  @ApiProperty({ example: true })
  hasMore: boolean;

  @ApiProperty({ example: 30 })
  limit: number;
}

export class ApiSuccessDto<T = unknown> {
  @ApiProperty({ example: true })
  success: true;

  @ApiProperty({ example: 'DELIVERY_CREATED' })
  code: string;

  @ApiProperty({ example: 'Delivery created successfully.' })
  message: string;

  @ApiProperty()
  data: T;

  @ApiPropertyOptional({ nullable: true, type: PageMetaDto })
  meta: PageMetaDto | CursorMetaDto | null;
}

export class FieldErrorDto {
  @ApiProperty({ example: 'phone' })
  field: string;

  @ApiProperty({ example: 'Phone number is invalid.' })
  message: string;
}

export class ApiErrorDto {
  @ApiProperty({ example: false })
  success: false;

  @ApiProperty({ example: 'DELIVERY_NOT_FOUND' })
  code: string;

  @ApiProperty({ example: 'Delivery not found.' })
  message: string;

  @ApiPropertyOptional({ type: [FieldErrorDto], nullable: true })
  errors: FieldErrorDto[] | null;

  @ApiPropertyOptional({ example: '2026-09-03T07:45:12.345Z' })
  timestamp?: string;

  @ApiPropertyOptional({ example: '/api/v1/mobile/customer/deliveries/abc' })
  path?: string;

  @ApiPropertyOptional({ example: '3f1c9e0a-2b7d-4a51-9c0e-6f2a1b8d4e33' })
  requestId?: string;
}
