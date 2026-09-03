import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponses, ApiSuccessResponse } from '../../common/decorators/api-docs.decorator.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { ResponseCode as ResponseCodeMeta } from '../../common/decorators/response-code.decorator.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { LocationDto, ReverseGeocodeQueryDto, SearchLocationsQueryDto } from './dto/location.dto.js';
import { LocationsService } from './locations.service.js';

@ApiTags('Locations')
@ApiBearerAuth()
@Controller({ path: 'mobile/locations', version: '1' })
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Get('search')
  @RateLimit({ bucket: 'locations:search', limit: 120, windowSeconds: 60, by: 'user' })
  @ResponseCodeMeta(ResponseCode.LOCATIONS_FETCHED)
  @ApiOperation({
    summary: 'Search for a place',
    description:
      'Pass the user’s position to rank results by proximity. Results are cached, and the `placeId` returned here is what GET /mobile/locations/:placeId resolves.',
  })
  @ApiSuccessResponse({ code: ResponseCode.LOCATIONS_FETCHED, type: LocationDto, isArray: true })
  @ApiErrorResponses(
    { status: 400, code: ResponseCode.VALIDATION_ERROR },
    { status: 503, code: ResponseCode.MAP_PROVIDER_UNAVAILABLE },
  )
  search(@Query() query: SearchLocationsQueryDto): Promise<LocationDto[]> {
    return this.locations.search(query);
  }

  @Get('reverse')
  @RateLimit({ bucket: 'locations:reverse', limit: 120, windowSeconds: 60, by: 'user' })
  @ResponseCodeMeta(ResponseCode.LOCATION_FETCHED)
  @ApiOperation({
    summary: 'Find the address at a point',
    description: 'Used for “use my current location” and for dropping a pin on the map.',
  })
  @ApiSuccessResponse({ code: ResponseCode.LOCATION_FETCHED, type: LocationDto })
  @ApiErrorResponses(
    { status: 404, code: ResponseCode.LOCATION_NOT_FOUND },
    { status: 503, code: ResponseCode.MAP_PROVIDER_UNAVAILABLE },
  )
  reverse(@Query() query: ReverseGeocodeQueryDto): Promise<LocationDto> {
    return this.locations.reverseGeocode(query);
  }

  @Get(':placeId')
  @ResponseCodeMeta(ResponseCode.LOCATION_FETCHED)
  @ApiOperation({
    summary: 'Resolve a place id from a search result',
    description: 'The map provider has no detail endpoint, so ids resolve from a cache that expires.',
  })
  @ApiParam({ name: 'placeId', example: 'W:687168292' })
  @ApiSuccessResponse({ code: ResponseCode.LOCATION_FETCHED, type: LocationDto })
  @ApiErrorResponses({ status: 404, code: ResponseCode.LOCATION_NOT_FOUND })
  getPlace(@Param('placeId') placeId: string): Promise<LocationDto> {
    return this.locations.getPlace(placeId);
  }
}
