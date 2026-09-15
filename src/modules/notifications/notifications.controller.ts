import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponses, ApiPaginatedResponse, ApiSuccessResponse } from '../../common/decorators/api-docs.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { ResponseCode as ResponseCodeMeta } from '../../common/decorators/response-code.decorator.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { IdParamDto } from '../../common/dto/id-param.dto.js';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface.js';
import type { PaginatedResult } from '../../common/interfaces/paginated.interface.js';
import {
  ListNotificationsQueryDto,
  NotificationDto,
  RegisterDeviceDto,
  UnreadCountDto,
} from './dto/notification.dto.js';
import { NotificationsService } from './notifications.service.js';

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller({ path: 'mobile', version: '1' })
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('notifications')
  @ResponseCodeMeta(ResponseCode.NOTIFICATIONS_FETCHED)
  @ApiOperation({
    summary: 'Your notifications',
    description:
      'Newest first. Each app sees its own — the driver app its job and payout notices, the customer app its delivery updates — plus those meant for both, such as account notices. A build that has not said which app it is sees everything.',
  })
  @ApiPaginatedResponse({ code: ResponseCode.NOTIFICATIONS_FETCHED, type: NotificationDto })
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListNotificationsQueryDto,
  ): Promise<PaginatedResult<NotificationDto>> {
    return this.notifications.findAll(user.userId, user.app, query);
  }

  @Get('notifications/unread-count')
  @ResponseCodeMeta(ResponseCode.NOTIFICATIONS_FETCHED)
  @ApiOperation({
    summary: 'How many are unread',
    description: 'For the badge, without fetching the list. Counts this app’s inbox only.',
  })
  @ApiSuccessResponse({ code: ResponseCode.NOTIFICATIONS_FETCHED, type: UnreadCountDto })
  unreadCount(@CurrentUser() user: AuthenticatedUser): Promise<UnreadCountDto> {
    return this.notifications.unreadCount(user.userId, user.app);
  }

  @Patch('notifications/:id/read')
  @ResponseCodeMeta(ResponseCode.NOTIFICATION_READ)
  @ApiOperation({ summary: 'Mark one as read' })
  @ApiSuccessResponse({ code: ResponseCode.NOTIFICATION_READ })
  @ApiErrorResponses({ status: 404, code: ResponseCode.NOTIFICATION_NOT_FOUND })
  async markRead(@CurrentUser('userId') userId: string, @Param() params: IdParamDto): Promise<null> {
    await this.notifications.markRead(userId, params.id);
    return null;
  }

  @Post('notifications/read-all')
  @HttpCode(HttpStatus.OK)
  @ResponseCodeMeta(ResponseCode.NOTIFICATIONS_READ_ALL)
  @ApiOperation({
    summary: 'Mark everything as read',
    description: 'Everything in this app’s inbox. The other app’s unread notifications stay unread.',
  })
  @ApiSuccessResponse({ code: ResponseCode.NOTIFICATIONS_READ_ALL })
  async markAllRead(@CurrentUser() user: AuthenticatedUser): Promise<null> {
    await this.notifications.markAllRead(user.userId, user.app);
    return null;
  }

  @Post('devices')
  @HttpCode(HttpStatus.CREATED)
  @ResponseCodeMeta(ResponseCode.DEVICE_REGISTERED)
  @ApiOperation({
    summary: 'Register this device for push notifications',
    description:
      'Send the FCM token after sign-in and whenever it is refreshed. A token registered by another account is reassigned to this one, so a shared phone does not keep the previous user’s alerts.',
  })
  @ApiSuccessResponse({ status: 201, code: ResponseCode.DEVICE_REGISTERED })
  @ApiErrorResponses({ status: 400, code: ResponseCode.VALIDATION_ERROR })
  async registerDevice(@CurrentUser('userId') userId: string, @Body() dto: RegisterDeviceDto): Promise<null> {
    await this.notifications.registerDevice(userId, dto);
    return null;
  }

  @Delete('devices/:installationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Stop push notifications for this device',
    description: 'Call this on sign-out.',
  })
  @ApiParam({ name: 'installationId' })
  async unregisterDevice(
    @CurrentUser('userId') userId: string,
    @Param('installationId') installationId: string,
  ): Promise<void> {
    await this.notifications.unregisterDevice(userId, installationId);
  }
}
