import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponses, ApiSuccessResponse } from '../../common/decorators/api-docs.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { ResponseCode as ResponseCodeMeta } from '../../common/decorators/response-code.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { IdParamDto } from '../../common/dto/id-param.dto.js';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface.js';
import { UserRole } from '../../generated/prisma/enums.js';
import {
  CreatePackageTemplateDto,
  PackageTemplateDto,
  UpdatePackageTemplateDto,
} from './dto/package-template.dto.js';
import { PackageTemplatesService } from './package-templates.service.js';

@ApiTags('Customer Delivery')
@ApiBearerAuth()
@Roles(UserRole.CUSTOMER)
@Controller({ path: 'mobile/customer/package-templates', version: '1' })
export class PackageTemplatesController {
  constructor(private readonly templates: PackageTemplatesService) {}

  @Get()
  @ResponseCodeMeta(ResponseCode.PACKAGE_TEMPLATES_FETCHED)
  @ApiOperation({ summary: 'Saved package presets, most recently used first' })
  @ApiSuccessResponse({ code: ResponseCode.PACKAGE_TEMPLATES_FETCHED, type: PackageTemplateDto, isArray: true })
  findAll(@CurrentUser('customerId') customerId: string): Promise<PackageTemplateDto[]> {
    return this.templates.findAll(customerId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ResponseCodeMeta(ResponseCode.PACKAGE_TEMPLATE_CREATED)
  @ApiOperation({ summary: 'Save a package preset' })
  @ApiSuccessResponse({ status: 201, code: ResponseCode.PACKAGE_TEMPLATE_CREATED, type: PackageTemplateDto })
  @ApiErrorResponses(
    { status: 400, code: ResponseCode.VALIDATION_ERROR },
    { status: 400, code: ResponseCode.FILE_NOT_FOUND },
  )
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePackageTemplateDto,
  ): Promise<PackageTemplateDto> {
    return this.templates.create(user.customerId as string, user.userId, dto);
  }

  @Patch(':id')
  @ResponseCodeMeta(ResponseCode.PACKAGE_TEMPLATE_UPDATED)
  @ApiOperation({ summary: 'Update a package preset' })
  @ApiSuccessResponse({ code: ResponseCode.PACKAGE_TEMPLATE_UPDATED, type: PackageTemplateDto })
  @ApiErrorResponses({ status: 404, code: ResponseCode.PACKAGE_TEMPLATE_NOT_FOUND })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: IdParamDto,
    @Body() dto: UpdatePackageTemplateDto,
  ): Promise<PackageTemplateDto> {
    return this.templates.update(user.customerId as string, user.userId, params.id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a package preset' })
  @ApiErrorResponses({ status: 404, code: ResponseCode.PACKAGE_TEMPLATE_NOT_FOUND })
  async remove(@CurrentUser('customerId') customerId: string, @Param() params: IdParamDto): Promise<void> {
    await this.templates.remove(customerId, params.id);
  }
}
