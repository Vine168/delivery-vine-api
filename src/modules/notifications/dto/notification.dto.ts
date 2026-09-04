import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { PageQueryDto } from '../../../common/dto/pagination.dto.js';
import { DevicePlatform, NotificationType, PushProvider } from '../../../generated/prisma/enums.js';

export class ListNotificationsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Only unread notifications.' })
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  @IsOptional()
  unreadOnly?: boolean;
}

export class RegisterDeviceDto {
  @ApiProperty({ example: 'A1B2C3D4-E5F6-7890-ABCD-EF1234567890' })
  @IsString()
  @MaxLength(128)
  installationId: string;

  @ApiProperty({ enum: DevicePlatform })
  @IsEnum(DevicePlatform)
  platform: DevicePlatform;

  @ApiProperty({ description: 'FCM registration token.' })
  @IsString()
  @MaxLength(512)
  pushToken: string;

  @ApiPropertyOptional({ enum: PushProvider, default: PushProvider.FCM })
  @IsEnum(PushProvider)
  @IsOptional()
  provider: PushProvider = PushProvider.FCM;

  @ApiPropertyOptional({ example: '1.4.0' })
  @IsString()
  @MaxLength(32)
  @IsOptional()
  appVersion?: string;

  @ApiPropertyOptional({ example: 'km-KH' })
  @IsString()
  @MaxLength(16)
  @IsOptional()
  locale?: string;
}

export class NotificationDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: NotificationType })
  type: NotificationType;

  @ApiProperty({ example: 'Driver assigned' })
  title: string;

  @ApiProperty({ example: 'Chan Sopheak is on the way to collect your package.' })
  body: string;

  @ApiPropertyOptional({ nullable: true, description: 'Ids the app needs to open the right screen.' })
  data: Record<string, unknown> | null;

  @ApiPropertyOptional({ nullable: true })
  deliveryId: string | null;

  @ApiProperty({ example: false })
  read: boolean;

  @ApiProperty()
  createdAt: string;
}

export class UnreadCountDto {
  @ApiProperty({ example: 3 })
  unread: number;
}
