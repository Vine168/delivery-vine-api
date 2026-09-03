import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';

/** cuid2 — 24 lowercase alphanumerics starting with a letter. */
const CUID2 = /^[a-z][a-z0-9]{23}$/;

export class IdParamDto {
  @ApiProperty({ example: 'cm8x1a2b3c4d5e6f7g8h9i0j' })
  @IsString()
  @Length(24, 24)
  @Matches(CUID2, { message: 'id must be a valid identifier' })
  id: string;
}

export function isCuid2(value: string): boolean {
  return CUID2.test(value);
}
