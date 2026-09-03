import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponses, ApiSuccessResponse } from '../../common/decorators/api-docs.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { ResponseCode as ResponseCodeMeta } from '../../common/decorators/response-code.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { IdParamDto } from '../../common/dto/id-param.dto.js';
import { UserRole } from '../../generated/prisma/enums.js';
import { AddressesService } from './addresses.service.js';
import { AddressDto, CreateAddressDto, UpdateAddressDto } from './dto/address.dto.js';

@ApiTags('Customer Address')
@ApiBearerAuth()
@Roles(UserRole.CUSTOMER)
@Controller({ path: 'mobile/customer/addresses', version: '1' })
export class AddressesController {
  constructor(private readonly addresses: AddressesService) {}

  @Get()
  @ResponseCodeMeta(ResponseCode.ADDRESSES_FETCHED)
  @ApiOperation({ summary: 'List saved addresses', description: 'The default address is returned first.' })
  @ApiSuccessResponse({ code: ResponseCode.ADDRESSES_FETCHED, type: AddressDto, isArray: true })
  findAll(@CurrentUser('customerId') customerId: string): Promise<AddressDto[]> {
    return this.addresses.findAll(customerId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ResponseCodeMeta(ResponseCode.ADDRESS_CREATED)
  @ApiOperation({
    summary: 'Save an address',
    description: 'The first address a customer saves becomes their default automatically.',
  })
  @ApiSuccessResponse({ status: 201, code: ResponseCode.ADDRESS_CREATED, type: AddressDto })
  @ApiErrorResponses(
    { status: 400, code: ResponseCode.VALIDATION_ERROR },
    { status: 422, code: ResponseCode.ADDRESS_LIMIT_REACHED },
  )
  create(@CurrentUser('customerId') customerId: string, @Body() dto: CreateAddressDto): Promise<AddressDto> {
    return this.addresses.create(customerId, dto);
  }

  @Get(':id')
  @ResponseCodeMeta(ResponseCode.ADDRESS_FETCHED)
  @ApiOperation({ summary: 'Get one saved address' })
  @ApiSuccessResponse({ code: ResponseCode.ADDRESS_FETCHED, type: AddressDto })
  @ApiErrorResponses({ status: 404, code: ResponseCode.ADDRESS_NOT_FOUND })
  findOne(@CurrentUser('customerId') customerId: string, @Param() params: IdParamDto): Promise<AddressDto> {
    return this.addresses.findOne(customerId, params.id);
  }

  @Patch(':id')
  @ResponseCodeMeta(ResponseCode.ADDRESS_UPDATED)
  @ApiOperation({ summary: 'Update a saved address' })
  @ApiSuccessResponse({ code: ResponseCode.ADDRESS_UPDATED, type: AddressDto })
  @ApiErrorResponses({ status: 404, code: ResponseCode.ADDRESS_NOT_FOUND })
  update(
    @CurrentUser('customerId') customerId: string,
    @Param() params: IdParamDto,
    @Body() dto: UpdateAddressDto,
  ): Promise<AddressDto> {
    return this.addresses.update(customerId, params.id, dto);
  }

  @Patch(':id/default')
  @ResponseCodeMeta(ResponseCode.ADDRESS_DEFAULT_SET)
  @ApiOperation({
    summary: 'Make this the default address',
    description: 'Clears the flag on the previous default in the same transaction.',
  })
  @ApiSuccessResponse({ code: ResponseCode.ADDRESS_DEFAULT_SET, type: AddressDto })
  @ApiErrorResponses({ status: 404, code: ResponseCode.ADDRESS_NOT_FOUND })
  setDefault(@CurrentUser('customerId') customerId: string, @Param() params: IdParamDto): Promise<AddressDto> {
    return this.addresses.setDefault(customerId, params.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a saved address',
    description: 'Deleting the default promotes the most recently updated remaining address.',
  })
  @ApiErrorResponses({ status: 404, code: ResponseCode.ADDRESS_NOT_FOUND })
  async remove(@CurrentUser('customerId') customerId: string, @Param() params: IdParamDto): Promise<void> {
    await this.addresses.remove(customerId, params.id);
  }
}
