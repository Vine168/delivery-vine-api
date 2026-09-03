import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiSuccessResponse } from '../../common/decorators/api-docs.decorator.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { ResponseCode as ResponseCodeMeta } from '../../common/decorators/response-code.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { UserRole } from '../../generated/prisma/enums.js';
import { NearbyDriverDto, NearbyDriversQueryDto } from './dto/nearby-driver.dto.js';
import { NearbyDriversService } from './nearby-drivers.service.js';

@ApiTags('Customer Delivery')
@ApiBearerAuth()
@Roles(UserRole.CUSTOMER)
@Controller({ path: 'mobile/customer/drivers', version: '1' })
export class CustomerDriversController {
  constructor(private readonly nearby: NearbyDriversService) {}

  @Get('nearby')
  @RateLimit({ bucket: 'drivers:nearby', limit: 120, windowSeconds: 60, by: 'user' })
  @ResponseCodeMeta(ResponseCode.NEARBY_DRIVERS_FETCHED)
  @ApiOperation({
    summary: 'Drivers near a point',
    description:
      'For the pins on the booking map. Returns position, vehicle type and distance only — no identity, and coordinates are rounded to about 30 m.',
  })
  @ApiSuccessResponse({ code: ResponseCode.NEARBY_DRIVERS_FETCHED, type: NearbyDriverDto, isArray: true })
  find(@Query() query: NearbyDriversQueryDto): Promise<NearbyDriverDto[]> {
    return this.nearby.find(query);
  }
}
