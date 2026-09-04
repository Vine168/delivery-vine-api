import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponses, ApiSuccessResponse } from '../../common/decorators/api-docs.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { ResponseCode as ResponseCodeMeta } from '../../common/decorators/response-code.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { UserRole } from '../../generated/prisma/enums.js';
import { FavoriteDriverDto } from './dto/favorite-driver.dto.js';
import { FavoriteDriversService } from './favorite-drivers.service.js';

@ApiTags('Customer Delivery')
@ApiBearerAuth()
@Roles(UserRole.CUSTOMER)
@Controller({ path: 'mobile/customer/favorite-drivers', version: '1' })
export class FavoriteDriversController {
  constructor(private readonly favorites: FavoriteDriversService) {}

  @Get()
  @ResponseCodeMeta(ResponseCode.FAVORITE_DRIVERS_FETCHED)
  @ApiOperation({
    summary: 'Drivers you have saved',
    description: 'Matching offers a delivery to a saved driver before anyone else.',
  })
  @ApiSuccessResponse({ code: ResponseCode.FAVORITE_DRIVERS_FETCHED, type: FavoriteDriverDto, isArray: true })
  findAll(@CurrentUser('customerId') customerId: string): Promise<FavoriteDriverDto[]> {
    return this.favorites.findAll(customerId);
  }

  @Post(':driverId')
  @HttpCode(HttpStatus.CREATED)
  @ResponseCodeMeta(ResponseCode.FAVORITE_DRIVER_ADDED)
  @ApiOperation({
    summary: 'Save a driver',
    description: 'Available once that driver has completed a delivery for you.',
  })
  @ApiParam({ name: 'driverId' })
  @ApiSuccessResponse({ status: 201, code: ResponseCode.FAVORITE_DRIVER_ADDED })
  @ApiErrorResponses(
    { status: 404, code: ResponseCode.DRIVER_NOT_FOUND },
    { status: 409, code: ResponseCode.FAVORITE_DRIVER_ALREADY_ADDED },
    { status: 422, code: ResponseCode.RATING_NOT_ALLOWED, description: 'No completed delivery with this driver.' },
  )
  async add(@CurrentUser('customerId') customerId: string, @Param('driverId') driverId: string): Promise<null> {
    await this.favorites.add(customerId, driverId);
    return null;
  }

  @Delete(':driverId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a saved driver' })
  @ApiParam({ name: 'driverId' })
  @ApiErrorResponses({ status: 404, code: ResponseCode.DRIVER_NOT_FOUND })
  async remove(@CurrentUser('customerId') customerId: string, @Param('driverId') driverId: string): Promise<void> {
    await this.favorites.remove(customerId, driverId);
  }
}
