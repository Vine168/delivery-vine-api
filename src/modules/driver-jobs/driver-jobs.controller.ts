import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponses, ApiSuccessResponse } from '../../common/decorators/api-docs.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { ResponseCode as ResponseCodeMeta } from '../../common/decorators/response-code.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { IdParamDto } from '../../common/dto/id-param.dto.js';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface.js';
import { UserRole } from '../../generated/prisma/enums.js';
import { DriverJobsService } from './driver-jobs.service.js';
import { DeclineJobDto, JobOfferDto } from './dto/job.dto.js';

@ApiTags('Driver Job')
@ApiBearerAuth()
@Roles(UserRole.DRIVER)
@Controller({ path: 'mobile/driver/jobs', version: '1' })
export class DriverJobsController {
  constructor(private readonly jobs: DriverJobsService) {}

  @Get('requests')
  @ResponseCodeMeta(ResponseCode.JOB_REQUESTS_FETCHED)
  @ApiOperation({
    summary: 'Job offers waiting for an answer',
    description:
      'Offers expire, so this list shrinks on its own. Customer contact details are withheld until a job is accepted.',
  })
  @ApiSuccessResponse({ code: ResponseCode.JOB_REQUESTS_FETCHED, type: JobOfferDto, isArray: true })
  findRequests(@CurrentUser('driverId') driverId: string): Promise<JobOfferDto[]> {
    return this.jobs.findRequests(driverId);
  }

  @Get(':id')
  @ResponseCodeMeta(ResponseCode.JOB_FETCHED)
  @ApiOperation({
    summary: 'One job offer or accepted job',
    description: 'A driver can only read a delivery that was offered to them.',
  })
  @ApiSuccessResponse({ code: ResponseCode.JOB_FETCHED, type: JobOfferDto })
  @ApiErrorResponses({ status: 404, code: ResponseCode.JOB_NOT_FOUND })
  findOne(@CurrentUser('driverId') driverId: string, @Param() params: IdParamDto): Promise<JobOfferDto> {
    return this.jobs.findOne(driverId, params.id);
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @ResponseCodeMeta(ResponseCode.JOB_ACCEPTED)
  @ApiOperation({
    summary: 'Accept a job',
    description:
      'The same job is offered to several drivers and exactly one can win it. A driver who loses the race gets 409 DELIVERY_ALREADY_ASSIGNED and should remove the offer from their screen.',
  })
  @ApiSuccessResponse({ code: ResponseCode.JOB_ACCEPTED, type: JobOfferDto })
  @ApiErrorResponses(
    { status: 404, code: ResponseCode.JOB_NOT_FOUND },
    { status: 409, code: ResponseCode.DELIVERY_ALREADY_ASSIGNED },
    { status: 409, code: ResponseCode.JOB_OFFER_EXPIRED },
    { status: 409, code: ResponseCode.JOB_ALREADY_RESPONDED },
    { status: 409, code: ResponseCode.DRIVER_HAS_ACTIVE_DELIVERY },
    { status: 422, code: ResponseCode.DRIVER_NOT_ONLINE },
  )
  accept(@CurrentUser() user: AuthenticatedUser, @Param() params: IdParamDto): Promise<JobOfferDto> {
    return this.jobs.accept(user.driverId as string, user.userId, params.id);
  }

  @Post(':id/decline')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Decline a job',
    description: 'The driver is not offered this delivery again in a later round.',
  })
  @ApiBody({ type: DeclineJobDto, required: false })
  @ApiErrorResponses(
    { status: 404, code: ResponseCode.JOB_NOT_FOUND },
    { status: 409, code: ResponseCode.JOB_OFFER_EXPIRED },
    { status: 409, code: ResponseCode.JOB_ALREADY_RESPONDED },
  )
  async decline(
    @CurrentUser('driverId') driverId: string,
    @Param() params: IdParamDto,
    @Body() dto: DeclineJobDto,
  ): Promise<void> {
    await this.jobs.decline(driverId, params.id, dto ?? {});
  }
}
