import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { ApiSuccessResponse } from '../../common/decorators/api-docs.decorator.js';
import { ResponseCode as ResponseCodeMeta } from '../../common/decorators/response-code.decorator.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { Currency } from '../../generated/prisma/enums.js';
import { VehicleTypeDto } from './dto/vehicle-type.dto.js';
import { VehicleTypesService } from './vehicle-types.service.js';

class VehicleTypeQueryDto {
  @IsEnum(Currency)
  @IsOptional()
  currency: Currency = Currency.KHR;
}

@ApiTags('Customer Delivery')
@ApiBearerAuth()
@Controller({ path: 'mobile/vehicle-types', version: '1' })
export class VehicleTypesController {
  constructor(private readonly vehicleTypes: VehicleTypesService) {}

  @Get()
  @ResponseCodeMeta(ResponseCode.VEHICLE_TYPES_FETCHED)
  @ApiOperation({
    summary: 'List vehicle types',
    description: 'Includes the base fare and per-kilometre rate from the active pricing rule for the requested currency.',
  })
  @ApiQuery({ name: 'currency', enum: Currency, required: false })
  @ApiSuccessResponse({ code: ResponseCode.VEHICLE_TYPES_FETCHED, type: VehicleTypeDto, isArray: true })
  findAll(@Query() query: VehicleTypeQueryDto): Promise<VehicleTypeDto[]> {
    return this.vehicleTypes.findAll(query.currency);
  }
}
