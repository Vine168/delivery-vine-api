import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsLatitude, IsLongitude, IsNumber, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import { Type } from 'class-transformer';
import { CursorQueryDto } from '../../../common/dto/pagination.dto.js';
import { MessageType } from '../../../generated/prisma/enums.js';

export class SendMessageDto {
  @ApiPropertyOptional({ enum: MessageType, default: MessageType.TEXT })
  @IsEnum(MessageType)
  @IsOptional()
  type: MessageType = MessageType.TEXT;

  @ApiPropertyOptional({ example: 'I am at the blue gate' })
  @ValidateIf((dto: SendMessageDto) => dto.type === MessageType.TEXT)
  @IsString()
  @MaxLength(2_000)
  body?: string;

  @ApiPropertyOptional({ description: 'File id from POST /mobile/uploads with purpose CHAT_ATTACHMENT.' })
  @ValidateIf((dto: SendMessageDto) => dto.type === MessageType.IMAGE)
  @IsString()
  @MaxLength(32)
  fileId?: string;

  @ApiPropertyOptional({ example: 11.5564 })
  @ValidateIf((dto: SendMessageDto) => dto.type === MessageType.LOCATION)
  @Type(() => Number)
  @IsNumber()
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional({ example: 104.9282 })
  @ValidateIf((dto: SendMessageDto) => dto.type === MessageType.LOCATION)
  @Type(() => Number)
  @IsNumber()
  @IsLongitude()
  longitude?: number;
}

export class MessageQueryDto extends CursorQueryDto {}

export class MessageDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  conversationId: string;

  @ApiProperty({ enum: MessageType })
  type: MessageType;

  @ApiPropertyOptional({ nullable: true })
  body: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Presigned URL; expires.' })
  fileUrl: string | null;

  @ApiPropertyOptional({ nullable: true })
  latitude: number | null;

  @ApiPropertyOptional({ nullable: true })
  longitude: number | null;

  @ApiProperty({ example: 'Chan Sopheak' })
  senderName: string;

  @ApiProperty({ example: true, description: 'Whether this message was sent by you.' })
  mine: boolean;

  @ApiProperty()
  createdAt: string;
}

export class ConversationDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  deliveryId: string;

  @ApiProperty({ example: 'ORD-20260903-00128' })
  bookingCode: string;

  @ApiProperty({ example: 'Chan Sopheak', description: 'The other participant.' })
  counterpartName: string;

  @ApiPropertyOptional({ nullable: true })
  counterpartAvatarUrl: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Preview of the most recent message.' })
  lastMessage: string | null;

  @ApiPropertyOptional({ nullable: true })
  lastMessageAt: string | null;

  @ApiProperty({ example: 2 })
  unreadCount: number;

  @ApiProperty({ example: false, description: 'A closed conversation can be read but not written to.' })
  closed: boolean;
}
