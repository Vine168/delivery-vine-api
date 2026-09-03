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
import { DeliveryExecutionService } from '../deliveries/delivery-execution.service.js';
import {
  ArrivedDto,
  CompleteDeliveryDto,
  ConfirmPickupDto,
  DriverCancelJobDto,
  ProofOfDeliveryDto,
  ProofOfDeliveryViewDto,
} from '../deliveries/dto/execution.dto.js';
import { DriverJobsService } from './driver-jobs.service.js';
import { DeclineJobDto, JobOfferDto } from './dto/job.dto.js';

@ApiTags('Driver Job')
@ApiBearerAuth()
@Roles(UserRole.DRIVER)
@Controller({ path: 'mobile/driver/jobs', version: '1' })
export class DriverJobsController {
  constructor(
    private readonly jobs: DriverJobsService,
    private readonly execution: DeliveryExecutionService,
  ) {}

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

  // ── Execution ──────────────────────────────────────────────────────────
  //
  // Each step validates the transition against the state machine, writes the
  // change and its history row in one transaction, and refuses anything out of
  // order. The app's idea of the current status is never consulted.

  @Post(':id/arrive-pickup')
  @HttpCode(HttpStatus.OK)
  @ResponseCodeMeta(ResponseCode.ARRIVED_PICKUP_CONFIRMED)
  @ApiOperation({
    summary: 'Report arrival at the pickup',
    description: 'Only from DRIVER_ASSIGNED. Send your position and it is recorded with the transition.',
  })
  @ApiBody({ type: ArrivedDto, required: false })
  @ApiSuccessResponse({ code: ResponseCode.ARRIVED_PICKUP_CONFIRMED })
  @ApiErrorResponses(
    { status: 404, code: ResponseCode.DELIVERY_NOT_ASSIGNED },
    { status: 422, code: ResponseCode.DELIVERY_INVALID_TRANSITION },
  )
  async arrivePickup(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: IdParamDto,
    @Body() dto: ArrivedDto,
  ): Promise<null> {
    await this.execution.arriveAtPickup(user.driverId as string, user.userId, params.id, dto ?? {});
    return null;
  }

  @Post(':id/confirm-pickup')
  @HttpCode(HttpStatus.OK)
  @ResponseCodeMeta(ResponseCode.PICKUP_CONFIRMED)
  @ApiOperation({
    summary: 'Confirm the package is collected',
    description: 'Only from ARRIVED_PICKUP. The delivery moves to IN_TRANSIT on its own once you leave the pickup.',
  })
  @ApiBody({ type: ConfirmPickupDto, required: false })
  @ApiSuccessResponse({ code: ResponseCode.PICKUP_CONFIRMED })
  @ApiErrorResponses(
    { status: 404, code: ResponseCode.DELIVERY_NOT_ASSIGNED },
    { status: 422, code: ResponseCode.DELIVERY_INVALID_TRANSITION },
  )
  async confirmPickup(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: IdParamDto,
    @Body() dto: ConfirmPickupDto,
  ): Promise<null> {
    await this.execution.confirmPickup(user.driverId as string, user.userId, params.id, dto ?? {});
    return null;
  }

  @Post(':id/arrive-dropoff')
  @HttpCode(HttpStatus.OK)
  @ResponseCodeMeta(ResponseCode.ARRIVED_DROPOFF_CONFIRMED)
  @ApiOperation({
    summary: 'Report arrival at the drop-off',
    description: 'From PICKED_UP or IN_TRANSIT — a driver who drove straight there never passed through IN_TRANSIT.',
  })
  @ApiBody({ type: ArrivedDto, required: false })
  @ApiSuccessResponse({ code: ResponseCode.ARRIVED_DROPOFF_CONFIRMED })
  @ApiErrorResponses(
    { status: 404, code: ResponseCode.DELIVERY_NOT_ASSIGNED },
    { status: 422, code: ResponseCode.DELIVERY_INVALID_TRANSITION },
  )
  async arriveDropoff(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: IdParamDto,
    @Body() dto: ArrivedDto,
  ): Promise<null> {
    await this.execution.arriveAtDropoff(user.driverId as string, user.userId, params.id, dto ?? {});
    return null;
  }

  @Post(':id/proof-of-delivery')
  @HttpCode(HttpStatus.CREATED)
  @ResponseCodeMeta(ResponseCode.PROOF_OF_DELIVERY_SAVED)
  @ApiOperation({
    summary: 'Attach proof of delivery',
    description:
      'Upload the photo first with POST /mobile/uploads (purpose PROOF_OF_DELIVERY), then send its id here. Sending it again replaces the previous one, so a blurred photo can be retaken.',
  })
  @ApiSuccessResponse({ status: 201, code: ResponseCode.PROOF_OF_DELIVERY_SAVED, type: ProofOfDeliveryViewDto })
  @ApiErrorResponses(
    { status: 400, code: ResponseCode.FILE_NOT_FOUND },
    { status: 404, code: ResponseCode.DELIVERY_NOT_ASSIGNED },
    { status: 422, code: ResponseCode.DELIVERY_INVALID_TRANSITION },
  )
  saveProof(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: IdParamDto,
    @Body() dto: ProofOfDeliveryDto,
  ): Promise<ProofOfDeliveryViewDto> {
    return this.execution.saveProofOfDelivery(user.driverId as string, user.userId, params.id, dto);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @ResponseCodeMeta(ResponseCode.DELIVERY_COMPLETED)
  @ApiOperation({
    summary: 'Complete the delivery',
    description:
      'Only from ARRIVED_DROPOFF, and only once proof of delivery exists. Writes the immutable earning snapshot and frees you for the next job. Cash deliveries require confirming the amount collected.',
  })
  @ApiBody({ type: CompleteDeliveryDto, required: false })
  @ApiSuccessResponse({ code: ResponseCode.DELIVERY_COMPLETED })
  @ApiErrorResponses(
    { status: 404, code: ResponseCode.DELIVERY_NOT_ASSIGNED },
    { status: 422, code: ResponseCode.PROOF_OF_DELIVERY_REQUIRED },
    { status: 422, code: ResponseCode.DELIVERY_INVALID_TRANSITION },
  )
  async complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: IdParamDto,
    @Body() dto: CompleteDeliveryDto,
  ): Promise<null> {
    await this.execution.complete(user.driverId as string, user.userId, params.id, dto ?? {});
    return null;
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ResponseCodeMeta(ResponseCode.DELIVERY_CANCELLED, 'Delivery handed back and offered to another driver.')
  @ApiOperation({
    summary: 'Hand the job back',
    description:
      'Allowed before you collect the package. The customer’s booking is NOT cancelled — it returns to the pool for another driver, and you are not offered it again. Once you have the package this becomes a support matter.',
  })
  @ApiSuccessResponse({ code: ResponseCode.DELIVERY_CANCELLED })
  @ApiErrorResponses(
    { status: 404, code: ResponseCode.DELIVERY_NOT_ASSIGNED },
    { status: 422, code: ResponseCode.DELIVERY_INVALID_TRANSITION, description: 'Too late — the package is already with you.' },
  )
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: IdParamDto,
    @Body() dto: DriverCancelJobDto,
  ): Promise<null> {
    await this.execution.releaseJob(user.driverId as string, user.userId, params.id, dto.reason);
    return null;
  }
}
