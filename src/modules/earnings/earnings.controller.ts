import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponses, ApiPaginatedResponse, ApiSuccessResponse } from '../../common/decorators/api-docs.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { ResponseCode as ResponseCodeMeta } from '../../common/decorators/response-code.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { IdParamDto } from '../../common/dto/id-param.dto.js';
import type { PaginatedResult } from '../../common/interfaces/paginated.interface.js';
import { UserRole } from '../../generated/prisma/enums.js';
import { EarningsService } from './earnings.service.js';
import {
  EarningDto,
  EarningsHistoryQueryDto,
  EarningsSummaryDto,
  EarningsSummaryQueryDto,
} from './dto/earning.dto.js';

@ApiTags('Driver Earnings')
@ApiBearerAuth()
@Roles(UserRole.DRIVER)
@Controller({ path: 'mobile/driver/earnings', version: '1' })
export class EarningsController {
  constructor(private readonly earnings: EarningsService) {}

  @Get('summary')
  @ResponseCodeMeta(ResponseCode.EARNINGS_SUMMARY_FETCHED)
  @ApiOperation({
    summary: 'Earnings for today, this week or this month',
    description: 'Gross, commission and net, computed from the immutable snapshots taken when each delivery completed.',
  })
  @ApiSuccessResponse({ code: ResponseCode.EARNINGS_SUMMARY_FETCHED, type: EarningsSummaryDto })
  summary(
    @CurrentUser('driverId') driverId: string,
    @Query() query: EarningsSummaryQueryDto,
  ): Promise<EarningsSummaryDto> {
    return this.earnings.summary(driverId, query);
  }

  @Get('history')
  @ResponseCodeMeta(ResponseCode.EARNINGS_FETCHED)
  @ApiOperation({ summary: 'Every delivery you have been paid for, newest first' })
  @ApiPaginatedResponse({ code: ResponseCode.EARNINGS_FETCHED, type: EarningDto })
  history(
    @CurrentUser('driverId') driverId: string,
    @Query() query: EarningsHistoryQueryDto,
  ): Promise<PaginatedResult<EarningDto>> {
    return this.earnings.history(driverId, query);
  }

  @Get(':id')
  @ResponseCodeMeta(ResponseCode.EARNING_FETCHED)
  @ApiOperation({
    summary: 'One earning',
    description: 'Shows the trip amount, the commission taken and what you kept, exactly as recorded at completion.',
  })
  @ApiSuccessResponse({ code: ResponseCode.EARNING_FETCHED, type: EarningDto })
  @ApiErrorResponses({ status: 404, code: ResponseCode.EARNING_NOT_FOUND })
  findOne(@CurrentUser('driverId') driverId: string, @Param() params: IdParamDto): Promise<EarningDto> {
    return this.earnings.findOne(driverId, params.id);
  }
}
