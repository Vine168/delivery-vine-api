import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { PageQueryDto } from '../../../common/dto/pagination.dto.js';
import { CampaignAudience, CampaignStatus, NotificationType } from '../../../generated/prisma/enums.js';

export class AdminAudienceDto {
  @ApiProperty({
    enum: CampaignAudience,
    description:
      'ONLINE_DRIVERS is resolved from the live presence store at the moment of sending, so it is genuinely who is working now.',
  })
  @IsEnum(CampaignAudience)
  audience: CampaignAudience;

  @ApiPropertyOptional({ description: 'Required for DRIVERS_IN_ZONE.' })
  @ValidateIf((dto: AdminAudienceDto) => dto.audience === CampaignAudience.DRIVERS_IN_ZONE)
  @IsString()
  @IsNotEmpty()
  zoneId?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Required for SPECIFIC_USERS. User ids, not profile ids.',
  })
  @ValidateIf((dto: AdminAudienceDto) => dto.audience === CampaignAudience.SPECIFIC_USERS)
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(1_000)
  @IsString({ each: true })
  userIds?: string[];
}

export class AdminSendNotificationDto extends AdminAudienceDto {
  @ApiProperty({ example: 'Service update' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title: string;

  @ApiProperty({ example: 'Deliveries in Toul Kork may be slower this evening because of road works.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1_000)
  body: string;

  @ApiPropertyOptional({
    enum: NotificationType,
    default: NotificationType.SYSTEM_ANNOUNCEMENT,
    description: 'PROMOTION for marketing, SYSTEM_ANNOUNCEMENT for operational notices.',
  })
  @IsEnum(NotificationType)
  @IsOptional()
  type?: NotificationType;

  @ApiPropertyOptional({
    description: 'Extra payload the app can act on, such as a screen to open.',
    example: { screen: 'promotions', promoCode: 'SAVE500' },
  })
  @IsObject()
  @IsOptional()
  data?: Record<string, unknown>;
}

export class AdminCampaignQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: CampaignStatus, isArray: true })
  @Transform(({ value }) => (Array.isArray(value) ? value : value === undefined ? undefined : [value]))
  @IsEnum(CampaignStatus, { each: true })
  @IsOptional()
  status?: CampaignStatus[];

  @ApiPropertyOptional({ enum: CampaignAudience })
  @IsEnum(CampaignAudience)
  @IsOptional()
  audience?: CampaignAudience;

  @ApiPropertyOptional({ description: 'Matches the title or the body.' })
  @IsString()
  @MaxLength(120)
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({ example: '2026-09-01' })
  @IsDateString()
  @IsOptional()
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-09-30' })
  @IsDateString()
  @IsOptional()
  dateTo?: string;
}

export class AdminNotificationQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Only what was sent to this user.' })
  @IsString()
  @MaxLength(32)
  @IsOptional()
  userId?: string;

  @ApiPropertyOptional({ enum: NotificationType })
  @IsEnum(NotificationType)
  @IsOptional()
  type?: NotificationType;

  @ApiPropertyOptional({ example: '2026-09-01' })
  @IsDateString()
  @IsOptional()
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-09-30' })
  @IsDateString()
  @IsOptional()
  dateTo?: string;
}

export class AdminAudiencePreviewDto {
  @ApiProperty({ enum: CampaignAudience })
  audience: CampaignAudience;

  @ApiProperty({
    example: 4_820,
    description: 'How many people this would reach if sent now. Suspended and deleted accounts are excluded.',
  })
  recipientCount: number;

  @ApiProperty({
    example: 3_640,
    description: 'Of those, how many have a device registered and could receive a push.',
  })
  reachableByPush: number;
}

export class AdminCampaignDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'Service update' })
  title: string;

  @ApiProperty()
  body: string;

  @ApiProperty({ enum: NotificationType })
  type: NotificationType;

  @ApiProperty({ enum: CampaignAudience })
  audience: CampaignAudience;

  @ApiPropertyOptional({ nullable: true, description: 'The audience’s parameters, as sent.' })
  filters: Record<string, unknown> | null;

  @ApiProperty({ enum: CampaignStatus })
  status: CampaignStatus;

  @ApiProperty({ example: 4_820, description: 'Resolved when the send began.' })
  totalRecipients: number;

  @ApiProperty({ example: 4_820 })
  sentCount: number;

  @ApiProperty({ example: 0 })
  failedCount: number;

  @ApiPropertyOptional({ nullable: true })
  failureReason: string | null;

  @ApiProperty({ example: 'Sok Dara' })
  createdByName: string;

  @ApiPropertyOptional({ nullable: true })
  startedAt: string | null;

  @ApiPropertyOptional({ nullable: true })
  completedAt: string | null;

  @ApiProperty()
  createdAt: string;
}

export class AdminNotificationRowDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  userId: string;

  @ApiProperty({ example: 'Sok Dara' })
  recipientName: string;

  @ApiProperty({ example: '+85512345678' })
  recipientPhone: string;

  @ApiProperty({ enum: NotificationType })
  type: NotificationType;

  @ApiProperty()
  title: string;

  @ApiProperty()
  body: string;

  @ApiPropertyOptional({ nullable: true })
  readAt: string | null;

  @ApiProperty({
    example: 'SENT',
    description: 'How the push attempt ended. NONE when the recipient has no device registered.',
  })
  pushStatus: string;

  @ApiProperty()
  createdAt: string;
}
