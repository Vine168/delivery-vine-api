import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class CreateRatingDto {
  @ApiProperty({ minimum: 1, maximum: 5, example: 5 })
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: 'A rating is between 1 and 5 stars.' })
  @Max(5, { message: 'A rating is between 1 and 5 stars.' })
  rating: number;

  @ApiPropertyOptional({ example: 'Fast and careful with the package' })
  @IsString()
  @MaxLength(1_000)
  @IsOptional()
  comment?: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['ON_TIME', 'POLITE'],
    description: 'Short tags the app offers as quick feedback.',
  })
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  @IsOptional()
  tags?: string[];
}

export class RatingDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  deliveryId: string;

  @ApiProperty({ example: 5 })
  rating: number;

  @ApiPropertyOptional({ nullable: true })
  comment: string | null;

  @ApiProperty({ type: [String] })
  tags: string[];

  @ApiProperty({ example: 'Chan Sopheak' })
  driverName: string;

  @ApiProperty()
  createdAt: string;
}
