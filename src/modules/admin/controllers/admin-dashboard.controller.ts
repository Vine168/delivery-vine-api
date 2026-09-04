import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiSuccessResponse } from '../../../common/decorators/api-docs.decorator.js';
import { ResponseCode as ResponseCodeMeta } from '../../../common/decorators/response-code.decorator.js';
import { ResponseCode } from '../../../common/constants/response-codes.js';
import { AdminDashboardDto, AdminDashboardQueryDto } from '../dto/admin-dashboard.dto.js';
import { RequirePermissions } from '../require-permissions.decorator.js';
import { AdminDashboardService } from '../services/admin-dashboard.service.js';

@ApiTags('Admin — Dashboard')
@Controller({ path: 'admin/dashboard', version: '1' })
export class AdminDashboardController {
  constructor(private readonly dashboard: AdminDashboardService) {}

  @Get()
  @RequirePermissions('dashboard.view')
  @ResponseCodeMeta(ResponseCode.DASHBOARD_FETCHED)
  @ApiOperation({
    summary: 'The operations overview',
    description:
      'Volumes, revenue, fleet state, the queues waiting on an operator, and a daily trend — in one call, so the home screen is not assembled from a dozen requests. Money is reported per currency in minor units and is never summed across currencies. Days are calendar days in the platform’s reporting timezone, which the payload names.',
  })
  @ApiSuccessResponse({ code: ResponseCode.DASHBOARD_FETCHED, type: AdminDashboardDto })
  overview(@Query() query: AdminDashboardQueryDto): Promise<AdminDashboardDto> {
    return this.dashboard.overview(query);
  }
}
