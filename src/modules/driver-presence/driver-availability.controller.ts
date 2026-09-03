import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponses, ApiSuccessResponse } from '../../common/decorators/api-docs.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { ResponseCode as ResponseCodeMeta } from '../../common/decorators/response-code.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { UserRole } from '../../generated/prisma/enums.js';
import { DriverAvailabilityService } from './driver-availability.service.js';
import { DriverDashboardService } from './driver-dashboard.service.js';
import {
  DriverAvailabilityDto,
  DriverLocationAckDto,
  UpdateAvailabilityDto,
  UpdateDriverLocationDto,
} from './dto/availability.dto.js';
import { DriverDashboardDto } from './dto/dashboard.dto.js';

@ApiTags('Driver Availability')
@ApiBearerAuth()
@Roles(UserRole.DRIVER)
@Controller({ path: 'mobile/driver', version: '1' })
export class DriverAvailabilityController {
  constructor(
    private readonly availability: DriverAvailabilityService,
    private readonly dashboard: DriverDashboardService,
  ) {}

  @Get('availability')
  @ResponseCodeMeta(ResponseCode.FETCHED)
  @ApiOperation({ summary: 'Current availability and today’s online time' })
  @ApiSuccessResponse({ code: ResponseCode.FETCHED, type: DriverAvailabilityDto })
  get(@CurrentUser('driverId') driverId: string): Promise<DriverAvailabilityDto> {
    return this.availability.get(driverId);
  }

  @Put('availability')
  @ResponseCodeMeta(ResponseCode.DRIVER_AVAILABILITY_UPDATED)
  @ApiOperation({
    summary: 'Go online or offline',
    description:
      'Going online re-checks approval, documents and vehicle on the server every time. BUSY is set by the platform while a job is active and cannot be requested. Going offline is refused while a delivery is in flight.',
  })
  @ApiSuccessResponse({ code: ResponseCode.DRIVER_AVAILABILITY_UPDATED, type: DriverAvailabilityDto })
  @ApiErrorResponses(
    { status: 409, code: ResponseCode.DRIVER_HAS_ACTIVE_DELIVERY },
    { status: 422, code: ResponseCode.DRIVER_NOT_APPROVED },
    { status: 422, code: ResponseCode.DRIVER_DOCUMENTS_INCOMPLETE },
    { status: 422, code: ResponseCode.DRIVER_VEHICLE_REQUIRED },
  )
  set(
    @CurrentUser('driverId') driverId: string,
    @Body() dto: UpdateAvailabilityDto,
  ): Promise<DriverAvailabilityDto> {
    return this.availability.set(driverId, dto);
  }

  @Put('location')
  @RateLimit({ bucket: 'driver:location', limit: 240, windowSeconds: 60, by: 'user' })
  @ResponseCodeMeta(ResponseCode.DRIVER_LOCATION_UPDATED)
  @ApiOperation({
    summary: 'Report the driver’s position',
    description:
      'Goes to Redis, which is what matching and the customer’s tracking screen read. A breadcrumb is written to the database only during an active delivery and only once per throttle window.',
  })
  @ApiSuccessResponse({ code: ResponseCode.DRIVER_LOCATION_UPDATED, type: DriverLocationAckDto })
  @ApiErrorResponses(
    { status: 400, code: ResponseCode.VALIDATION_ERROR },
    { status: 422, code: ResponseCode.DRIVER_NOT_ONLINE },
  )
  updateLocation(
    @CurrentUser('driverId') driverId: string,
    @Body() dto: UpdateDriverLocationDto,
  ): Promise<DriverLocationAckDto> {
    return this.availability.updateLocation(driverId, dto);
  }

  @Get('dashboard')
  @ResponseCodeMeta(ResponseCode.DRIVER_DASHBOARD_FETCHED)
  @ApiOperation({
    summary: 'Everything the driver home screen needs',
    description: 'One aggregate rather than ten calls: availability, online time, earnings, counts and readiness.',
  })
  @ApiSuccessResponse({ code: ResponseCode.DRIVER_DASHBOARD_FETCHED, type: DriverDashboardDto })
  getDashboard(@CurrentUser('driverId') driverId: string): Promise<DriverDashboardDto> {
    return this.dashboard.get(driverId);
  }
}
