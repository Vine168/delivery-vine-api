import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponses, ApiSuccessResponse } from '../../common/decorators/api-docs.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { ResponseCode as ResponseCodeMeta } from '../../common/decorators/response-code.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { IdParamDto } from '../../common/dto/id-param.dto.js';
import { UserRole } from '../../generated/prisma/enums.js';
import { CreateRatingDto, RatingDto } from './dto/rating.dto.js';
import { RatingsService } from './ratings.service.js';

@ApiTags('Rating')
@ApiBearerAuth()
@Roles(UserRole.CUSTOMER)
@Controller({ path: 'mobile/customer/deliveries', version: '1' })
export class RatingsController {
  constructor(private readonly ratings: RatingsService) {}

  @Post(':id/rating')
  @HttpCode(HttpStatus.CREATED)
  @ResponseCodeMeta(ResponseCode.RATING_SUBMITTED)
  @ApiOperation({
    summary: 'Rate a completed delivery',
    description:
      'Only the customer who booked it, only once, and only while it is recent. The driver’s average is recomputed from all their ratings rather than nudged, so it cannot drift.',
  })
  @ApiSuccessResponse({ status: 201, code: ResponseCode.RATING_SUBMITTED, type: RatingDto })
  @ApiErrorResponses(
    { status: 404, code: ResponseCode.DELIVERY_NOT_FOUND },
    { status: 409, code: ResponseCode.RATING_ALREADY_SUBMITTED },
    { status: 422, code: ResponseCode.RATING_NOT_ALLOWED },
  )
  create(
    @CurrentUser('customerId') customerId: string,
    @Param() params: IdParamDto,
    @Body() dto: CreateRatingDto,
  ): Promise<RatingDto> {
    return this.ratings.create(customerId, params.id, dto);
  }

  @Get(':id/rating')
  @ResponseCodeMeta(ResponseCode.RATING_FETCHED)
  @ApiOperation({ summary: 'Read back the rating you left' })
  @ApiSuccessResponse({ code: ResponseCode.RATING_FETCHED, type: RatingDto })
  @ApiErrorResponses({ status: 404, code: ResponseCode.RATING_NOT_FOUND })
  findOne(@CurrentUser('customerId') customerId: string, @Param() params: IdParamDto): Promise<RatingDto> {
    return this.ratings.findOne(customerId, params.id);
  }
}
