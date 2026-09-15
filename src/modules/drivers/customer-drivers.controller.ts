import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiSuccessResponse } from '../../common/decorators/api-docs.decorator.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { ResponseCode as ResponseCodeMeta } from '../../common/decorators/response-code.decorator.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { NearbyDriverDto, NearbyDriversQueryDto } from './dto/nearby-driver.dto.js';
import { NearbyDriversService } from './nearby-drivers.service.js';
import { RequiresCustomer } from '../../common/decorators/capability.decorator.js';

@ApiTags('Customer Delivery')
@ApiBearerAuth()
@RequiresCustomer()
@Controller({ path: 'mobile/customer/drivers', version: '1' })
export class CustomerDriversController {
  constructor(private readonly nearby: NearbyDriversService) {}

  @Get('nearby')
  @RateLimit({ bucket: 'drivers:nearby', limit: 120, windowSeconds: 60, by: 'user' })
  @ResponseCodeMeta(ResponseCode.NEARBY_DRIVERS_FETCHED)
  @ApiOperation({
    summary: 'Drivers near a point',
    description:
      'For the pins on the booking map. Returns position, vehicle type and distance only — no identity. Coordinates are rounded to about 110 m, and both the distance and the radius are measured to that rounded pin.',
  })
  @ApiSuccessResponse({ code: ResponseCode.NEARBY_DRIVERS_FETCHED, type: NearbyDriverDto, isArray: true })
  find(@Query() query: NearbyDriversQueryDto): Promise<NearbyDriverDto[]> {
    return this.nearby.find(query);
  }
}
