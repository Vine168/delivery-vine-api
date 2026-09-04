import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * What a customer sees about a driver they have saved.
 *
 * More than the anonymous map pins, because they have chosen this person and
 * have completed deliveries with them — but still no phone number until a
 * delivery is actually assigned.
 */
export class FavoriteDriverDto {
  @ApiProperty()
  driverId: string;

  @ApiProperty({ example: 'Chan Sopheak' })
  fullName: string;

  @ApiPropertyOptional({ nullable: true })
  avatarUrl: string | null;

  @ApiProperty({ example: 4.82 })
  ratingAverage: number;

  @ApiProperty({ example: 214 })
  ratingCount: number;

  @ApiProperty({ example: 613 })
  completedDeliveries: number;

  @ApiPropertyOptional({ nullable: true, example: 'MOTOR' })
  vehicleTypeCode: string | null;

  @ApiProperty({ example: true, description: 'Whether they are online right now.' })
  isOnline: boolean;

  @ApiProperty({ example: 3, description: 'Deliveries this customer has completed with them.' })
  deliveriesTogether: number;

  @ApiProperty()
  favouritedAt: string;
}
