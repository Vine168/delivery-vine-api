import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponses, ApiPaginatedResponse, ApiSuccessResponse } from '../../common/decorators/api-docs.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { ResponseCode as ResponseCodeMeta } from '../../common/decorators/response-code.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { IdParamDto } from '../../common/dto/id-param.dto.js';
import type { CursorPaginatedResult } from '../../common/interfaces/paginated.interface.js';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface.js';
import { UserRole } from '../../generated/prisma/enums.js';
import { ChatService } from './chat.service.js';
import { ConversationDto, MessageDto, MessageQueryDto, SendMessageDto } from './dto/chat.dto.js';

@ApiTags('Messages')
@ApiBearerAuth()
@Roles(UserRole.CUSTOMER, UserRole.DRIVER)
@Controller({ path: 'mobile/conversations', version: '1' })
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get()
  @ResponseCodeMeta(ResponseCode.CONVERSATIONS_FETCHED)
  @ApiOperation({
    summary: 'Your conversations',
    description: 'One per delivery, opened when a driver is assigned. Works for both customers and drivers.',
  })
  @ApiSuccessResponse({ code: ResponseCode.CONVERSATIONS_FETCHED, type: ConversationDto, isArray: true })
  findAll(@CurrentUser() user: AuthenticatedUser): Promise<ConversationDto[]> {
    return this.chat.findAll(user);
  }

  @Get(':id/messages')
  @ResponseCodeMeta(ResponseCode.MESSAGES_FETCHED)
  @ApiOperation({
    summary: 'Read a conversation',
    description: 'Newest first, cursor paginated. Reading marks the thread as read for you.',
  })
  @ApiPaginatedResponse({ code: ResponseCode.MESSAGES_FETCHED, type: MessageDto, cursor: true })
  @ApiErrorResponses({ status: 404, code: ResponseCode.CONVERSATION_NOT_FOUND })
  findMessages(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: IdParamDto,
    @Query() query: MessageQueryDto,
  ): Promise<CursorPaginatedResult<MessageDto>> {
    return this.chat.findMessages(user, params.id, query);
  }

  @Post(':id/messages')
  @HttpCode(HttpStatus.CREATED)
  @ResponseCodeMeta(ResponseCode.MESSAGE_SENT)
  @ApiOperation({
    summary: 'Send a message',
    description:
      'Text, an image (upload it first with purpose CHAT_ATTACHMENT) or a location. Delivered over the socket to the other party immediately.',
  })
  @ApiSuccessResponse({ status: 201, code: ResponseCode.MESSAGE_SENT, type: MessageDto })
  @ApiErrorResponses(
    { status: 400, code: ResponseCode.VALIDATION_ERROR },
    { status: 404, code: ResponseCode.CONVERSATION_NOT_FOUND },
    { status: 422, code: ResponseCode.CONVERSATION_CLOSED },
  )
  send(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: IdParamDto,
    @Body() dto: SendMessageDto,
  ): Promise<MessageDto> {
    return this.chat.send(user, params.id, dto);
  }
}
