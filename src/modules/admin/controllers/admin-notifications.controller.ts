import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiErrorResponses,
  ApiPaginatedResponse,
  ApiSuccessResponse,
} from '../../../common/decorators/api-docs.decorator.js';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { RateLimit } from '../../../common/decorators/rate-limit.decorator.js';
import { ResponseCode as ResponseCodeMeta } from '../../../common/decorators/response-code.decorator.js';
import { ResponseCode } from '../../../common/constants/response-codes.js';
import { IdParamDto } from '../../../common/dto/id-param.dto.js';
import type { PaginatedResult } from '../../../common/interfaces/paginated.interface.js';
import {
  AdminAudienceDto,
  AdminAudiencePreviewDto,
  AdminCampaignDto,
  AdminCampaignQueryDto,
  AdminNotificationQueryDto,
  AdminNotificationRowDto,
  AdminSendNotificationDto,
} from '../dto/admin-notification.dto.js';
import { RequirePermissions } from '../require-permissions.decorator.js';
import { AdminNotificationsService } from '../services/admin-notifications.service.js';

@ApiTags('Admin — Notifications')
@Controller({ path: 'admin/notifications', version: '1' })
export class AdminNotificationsController {
  constructor(private readonly notifications: AdminNotificationsService) {}

  @Post('audience-preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('notifications.view')
  @ResponseCodeMeta(ResponseCode.AUDIENCE_PREVIEWED)
  @ApiOperation({
    summary: 'How many people an audience covers',
    description:
      'Writes nothing. Call it before sending so nobody discovers the size of “all customers” only after pressing the button. Suspended and deleted accounts are excluded, and `reachableByPush` says how many of them have a device registered.',
  })
  @ApiSuccessResponse({ code: ResponseCode.AUDIENCE_PREVIEWED, type: AdminAudiencePreviewDto })
  preview(@Body() dto: AdminAudienceDto): Promise<AdminAudiencePreviewDto> {
    return this.notifications.preview(dto);
  }

  @Post()
  @RequirePermissions('notifications.send')
  @RateLimit({ bucket: 'admin:broadcast', limit: 5, windowSeconds: 300, by: 'user' })
  @ResponseCodeMeta(ResponseCode.CAMPAIGN_QUEUED)
  @ApiOperation({
    summary: 'Send a notification',
    description:
      'Returns as soon as the message is recorded; a worker delivers it in the background, because a broadcast is thousands of writes and thousands of push attempts and must never delay a driver’s job offer. Poll the campaign to watch it go out. The audience is resolved when sending begins, so ONLINE_DRIVERS reaches whoever is working at that moment.',
  })
  @ApiSuccessResponse({ status: 201, code: ResponseCode.CAMPAIGN_QUEUED, type: AdminCampaignDto })
  @ApiErrorResponses(
    { status: 400, code: ResponseCode.VALIDATION_ERROR },
    { status: 404, code: ResponseCode.ZONE_NOT_FOUND },
    { status: 422, code: ResponseCode.ACCOUNT_NOT_FOUND },
  )
  send(
    @CurrentUser('userId') userId: string,
    @Body() dto: AdminSendNotificationDto,
  ): Promise<AdminCampaignDto> {
    return this.notifications.send(userId, dto);
  }

  @Get()
  @RequirePermissions('notifications.view')
  @ResponseCodeMeta(ResponseCode.CAMPAIGNS_FETCHED)
  @ApiOperation({
    summary: 'What has been sent',
    description: 'Every campaign with how far it got — sent, failed, and why it stopped if it did.',
  })
  @ApiPaginatedResponse({ code: ResponseCode.CAMPAIGNS_FETCHED, type: AdminCampaignDto })
  findCampaigns(@Query() query: AdminCampaignQueryDto): Promise<PaginatedResult<AdminCampaignDto>> {
    return this.notifications.findCampaigns(query);
  }

  @Get('history')
  @RequirePermissions('notifications.view')
  @ResponseCodeMeta(ResponseCode.NOTIFICATIONS_FETCHED)
  @ApiOperation({
    summary: 'Individual notifications',
    description:
      'Everything the platform has told anyone, including the automatic delivery updates. Filter by user to answer “was this customer told?”. `pushStatus` is NONE when the recipient has no device registered, which is not the same as a push that failed.',
  })
  @ApiPaginatedResponse({ code: ResponseCode.NOTIFICATIONS_FETCHED, type: AdminNotificationRowDto })
  findNotifications(
    @Query() query: AdminNotificationQueryDto,
  ): Promise<PaginatedResult<AdminNotificationRowDto>> {
    return this.notifications.findNotifications(query);
  }

  @Get(':id')
  @RequirePermissions('notifications.view')
  @ResponseCodeMeta(ResponseCode.CAMPAIGN_FETCHED)
  @ApiOperation({ summary: 'One campaign, with its progress' })
  @ApiSuccessResponse({ code: ResponseCode.CAMPAIGN_FETCHED, type: AdminCampaignDto })
  @ApiErrorResponses({ status: 404, code: ResponseCode.CAMPAIGN_NOT_FOUND })
  findCampaign(@Param() params: IdParamDto): Promise<AdminCampaignDto> {
    return this.notifications.findCampaign(params.id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('notifications.send')
  @ResponseCodeMeta(ResponseCode.CAMPAIGN_CANCELLED)
  @ApiOperation({
    summary: 'Stop a message that has not gone out yet',
    description:
      'Only while it is still queued. A send already in flight cannot be recalled — the notifications written so far are on people’s phones — and this says so rather than pretending to undo it.',
  })
  @ApiSuccessResponse({ code: ResponseCode.CAMPAIGN_CANCELLED, type: AdminCampaignDto })
  @ApiErrorResponses(
    { status: 404, code: ResponseCode.CAMPAIGN_NOT_FOUND },
    { status: 409, code: ResponseCode.CAMPAIGN_NOT_CANCELLABLE },
  )
  cancel(
    @CurrentUser('userId') userId: string,
    @Param() params: IdParamDto,
  ): Promise<AdminCampaignDto> {
    return this.notifications.cancel(userId, params.id);
  }
}
