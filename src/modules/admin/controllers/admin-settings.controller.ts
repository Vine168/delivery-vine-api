import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Put } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponses, ApiSuccessResponse } from '../../../common/decorators/api-docs.decorator.js';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { ResponseCode as ResponseCodeMeta } from '../../../common/decorators/response-code.decorator.js';
import { ResponseCode } from '../../../common/constants/response-codes.js';
import { SettingsService } from '../../settings/settings.service.js';
import { AuditService } from '../audit.service.js';
import { AdminUpdateSettingDto } from '../dto/admin-catalogue.dto.js';
import { AdminSettingDto } from '../dto/admin-catalogue-response.dto.js';
import { RequirePermissions } from '../require-permissions.decorator.js';

@ApiTags('Admin — Settings')
@Controller({ path: 'admin/settings', version: '1' })
export class AdminSettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('settings.view')
  @ResponseCodeMeta(ResponseCode.SETTINGS_FETCHED)
  @ApiOperation({
    summary: 'Runtime settings',
    description:
      'The complete list — a key that is not here cannot be written, and a key is only here once something reads it, so the screen has no controls that quietly do nothing. Each entry carries the deployment’s own value alongside the one in force, so an operator can see what they have changed.',
  })
  @ApiSuccessResponse({ code: ResponseCode.SETTINGS_FETCHED, type: AdminSettingDto, isArray: true })
  findAll(): Promise<AdminSettingDto[]> {
    return this.settings.findAll();
  }

  @Put(':key')
  @RequirePermissions('settings.manage')
  @ResponseCodeMeta(ResponseCode.SETTING_UPDATED)
  @ApiParam({ name: 'key', example: 'matching.radiusMeters' })
  @ApiOperation({
    summary: 'Override a setting',
    description:
      'Takes effect within seconds, without a deploy. The value is checked against the catalogue’s range, so dispatch cannot be broken by a typo.',
  })
  @ApiSuccessResponse({ code: ResponseCode.SETTING_UPDATED, type: AdminSettingDto })
  @ApiErrorResponses(
    { status: 400, code: ResponseCode.VALIDATION_ERROR },
    { status: 404, code: ResponseCode.SETTING_NOT_FOUND },
  )
  async update(
    @CurrentUser('userId') userId: string,
    @Param('key') key: string,
    @Body() dto: AdminUpdateSettingDto,
  ): Promise<AdminSettingDto> {
    const before = await this.settings.findOne(key);
    const after = await this.settings.set(key, dto.value, userId);

    await this.audit.record({
      actorUserId: userId,
      action: 'setting.update',
      entityType: 'SystemSetting',
      entityId: key,
      summary: `Set ${before.label} to ${String(dto.value)}${before.unit ? ` ${before.unit}` : ''}`,
      before: { value: before.value, isOverridden: before.isOverridden },
      after: { value: after.value },
    });

    return after;
  }

  @Delete(':key')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('settings.manage')
  @ResponseCodeMeta(ResponseCode.SETTING_RESET)
  @ApiParam({ name: 'key', example: 'matching.radiusMeters' })
  @ApiOperation({
    summary: 'Drop an override',
    description: 'Returns the key to the deployment’s own configured value.',
  })
  @ApiSuccessResponse({ code: ResponseCode.SETTING_RESET, type: AdminSettingDto })
  @ApiErrorResponses({ status: 404, code: ResponseCode.SETTING_NOT_FOUND })
  async reset(@CurrentUser('userId') userId: string, @Param('key') key: string): Promise<AdminSettingDto> {
    const before = await this.settings.findOne(key);
    const after = await this.settings.reset(key);

    await this.audit.record({
      actorUserId: userId,
      action: 'setting.reset',
      entityType: 'SystemSetting',
      entityId: key,
      summary: `Reset ${before.label} to the deployment default`,
      before: { value: before.value },
      after: { value: after.value },
    });

    return after;
  }
}
