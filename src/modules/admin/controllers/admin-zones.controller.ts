import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiErrorResponses,
  ApiPaginatedResponse,
  ApiSuccessResponse,
} from '../../../common/decorators/api-docs.decorator.js';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { ResponseCode as ResponseCodeMeta } from '../../../common/decorators/response-code.decorator.js';
import { ResponseCode } from '../../../common/constants/response-codes.js';
import { IdParamDto } from '../../../common/dto/id-param.dto.js';
import type { PaginatedResult } from '../../../common/interfaces/paginated.interface.js';
import { AdminCreateZoneDto, AdminUpdateZoneDto, AdminZoneQueryDto } from '../dto/admin-catalogue.dto.js';
import { AdminZoneDto } from '../dto/admin-catalogue-response.dto.js';
import { RequirePermissions } from '../require-permissions.decorator.js';
import { AdminCatalogueService } from '../services/admin-catalogue.service.js';

@ApiTags('Admin — Zones')
@Controller({ path: 'admin/zones', version: '1' })
export class AdminZonesController {
  constructor(private readonly catalogue: AdminCatalogueService) {}

  @Get()
  @RequirePermissions('zones.view')
  @ResponseCodeMeta(ResponseCode.ZONES_FETCHED)
  @ApiOperation({
    summary: 'Service zones',
    description:
      'A zone is either a drawn polygon or a circle around a point. Each row shows how many drivers cover it and how many pricing rules are scoped to it.',
  })
  @ApiPaginatedResponse({ code: ResponseCode.ZONES_FETCHED, type: AdminZoneDto })
  findAll(@Query() query: AdminZoneQueryDto): Promise<PaginatedResult<AdminZoneDto>> {
    return this.catalogue.findZones(query);
  }

  @Get(':id')
  @RequirePermissions('zones.view')
  @ResponseCodeMeta(ResponseCode.ZONE_FETCHED)
  @ApiOperation({ summary: 'One zone, with its boundary' })
  @ApiSuccessResponse({ code: ResponseCode.ZONE_FETCHED, type: AdminZoneDto })
  @ApiErrorResponses({ status: 404, code: ResponseCode.ZONE_NOT_FOUND })
  findOne(@Param() params: IdParamDto): Promise<AdminZoneDto> {
    return this.catalogue.findZone(params.id);
  }

  @Post()
  @RequirePermissions('zones.manage')
  @ResponseCodeMeta(ResponseCode.ZONE_CREATED)
  @ApiOperation({
    summary: 'Draw a new zone',
    description:
      'A RADIUS zone needs a centre and a radius; a POLYGON zone needs a GeoJSON boundary. Only one shape is stored, so there is never a second answer to where the zone is.',
  })
  @ApiSuccessResponse({ status: 201, code: ResponseCode.ZONE_CREATED, type: AdminZoneDto })
  @ApiErrorResponses(
    { status: 400, code: ResponseCode.VALIDATION_ERROR },
    { status: 409, code: ResponseCode.ZONE_CODE_TAKEN },
  )
  create(@CurrentUser('userId') userId: string, @Body() dto: AdminCreateZoneDto): Promise<AdminZoneDto> {
    return this.catalogue.createZone(userId, dto);
  }

  @Patch(':id')
  @RequirePermissions('zones.manage')
  @ResponseCodeMeta(ResponseCode.ZONE_UPDATED)
  @ApiOperation({
    summary: 'Redraw or rename a zone',
    description: 'Switching the coverage type clears whatever the other shape used.',
  })
  @ApiSuccessResponse({ code: ResponseCode.ZONE_UPDATED, type: AdminZoneDto })
  @ApiErrorResponses(
    { status: 404, code: ResponseCode.ZONE_NOT_FOUND },
    { status: 409, code: ResponseCode.ZONE_CODE_TAKEN },
  )
  update(
    @CurrentUser('userId') userId: string,
    @Param() params: IdParamDto,
    @Body() dto: AdminUpdateZoneDto,
  ): Promise<AdminZoneDto> {
    return this.catalogue.updateZone(userId, params.id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('zones.manage')
  @ResponseCodeMeta(ResponseCode.ZONE_DELETED)
  @ApiOperation({
    summary: 'Retire a zone',
    description:
      'Soft: pricing rules still point at it and a delivery priced by a zone rule last month must stay explicable. Driver assignments to it are cleared, so the fleet screen does not show people covering a zone that no longer exists.',
  })
  @ApiSuccessResponse({ code: ResponseCode.ZONE_DELETED })
  @ApiErrorResponses({ status: 404, code: ResponseCode.ZONE_NOT_FOUND })
  async remove(@CurrentUser('userId') userId: string, @Param() params: IdParamDto): Promise<void> {
    await this.catalogue.deleteZone(userId, params.id);
  }
}
