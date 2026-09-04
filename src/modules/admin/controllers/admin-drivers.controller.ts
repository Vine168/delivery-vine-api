import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
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
import {
  AdminAssignZonesDto,
  AdminDriverDetailDto,
  AdminDriverDocumentDto,
  AdminDriverQueryDto,
  AdminDriverRowDto,
  AdminReasonDto,
  AdminReviewDocumentDto,
  AdminUpdateDriverDto,
  AdminZoneSummaryDto,
} from '../dto/admin-driver.dto.js';
import { AdminExportService } from '../services/admin-export.service.js';
import { RequirePermissions } from '../require-permissions.decorator.js';
import { AdminDriversService } from '../services/admin-drivers.service.js';

@ApiTags('Admin — Drivers')
@Controller({ path: 'admin/drivers', version: '1' })
export class AdminDriversController {
  constructor(
    private readonly drivers: AdminDriversService,
    private readonly exports: AdminExportService,
  ) {}

  @Get()
  @RequirePermissions('drivers.view')
  @ResponseCodeMeta(ResponseCode.ADMIN_DRIVERS_FETCHED)
  @ApiOperation({
    summary: 'The fleet',
    description:
      'Filterable by approval state, availability, zone and vehicle type, and searchable by name, phone or plate. `awaitingReview=true` is the approval queue. `onlineNow` comes from the live presence store, so it says whether the matcher can actually see the driver rather than what the availability table last recorded.',
  })
  @ApiPaginatedResponse({ code: ResponseCode.ADMIN_DRIVERS_FETCHED, type: AdminDriverRowDto })
  findAll(@Query() query: AdminDriverQueryDto): Promise<PaginatedResult<AdminDriverRowDto>> {
    return this.drivers.findAll(query);
  }

  @Get('export')
  @RequirePermissions('drivers.export')
  @ApiOperation({
    summary: 'Download the fleet as a spreadsheet',
    description:
      'Takes the same filters as the list, and includes each driver’s zones, rating and acceptance rate. Returns a CSV file rather than the response envelope. Money is written twice — an exact decimal for reading and the minor-unit integer the platform stores — with the currency in its own column. Exports are capped at 50,000 rows: past that the request is refused rather than silently truncated, because a file that stops halfway and looks complete is how figures quietly go missing. Every export is recorded in the audit log.',
  })
  @ApiOkResponse({ description: 'A CSV file.', content: { 'text/csv': {} } })
  @ApiErrorResponses({ status: 422, code: ResponseCode.EXPORT_TOO_LARGE })
  async export(
    @CurrentUser('userId') userId: string,
    @Query() query: AdminDriverQueryDto,
    @Res() response: Response,
  ): Promise<void> {
    await this.exports.drivers(userId, this.drivers.buildWhere(query), response);
  }

  @Get(':id')
  @RequirePermissions('drivers.view')
  @ResponseCodeMeta(ResponseCode.ADMIN_DRIVER_FETCHED)
  @ApiOperation({
    summary: 'One driver in full',
    description:
      'Profile, vehicles, documents with review state, zones, wallet balances per currency, last known position, and the readiness checklist — the same one the driver app shows, so the two can never disagree.',
  })
  @ApiSuccessResponse({ code: ResponseCode.ADMIN_DRIVER_FETCHED, type: AdminDriverDetailDto })
  @ApiErrorResponses({ status: 404, code: ResponseCode.DRIVER_NOT_FOUND })
  findOne(@Param() params: IdParamDto): Promise<AdminDriverDetailDto> {
    return this.drivers.findOne(params.id);
  }

  @Patch(':id')
  @RequirePermissions('drivers.edit')
  @ResponseCodeMeta(ResponseCode.DRIVER_UPDATED)
  @ApiOperation({
    summary: 'Correct a driver’s details',
    description:
      'Only the display name. Phone numbers are identity here — one phone holds one driver account — so they are changed through account recovery, not by an operator editing a field.',
  })
  @ApiSuccessResponse({ code: ResponseCode.DRIVER_UPDATED, type: AdminDriverDetailDto })
  @ApiErrorResponses({ status: 404, code: ResponseCode.DRIVER_NOT_FOUND })
  update(
    @CurrentUser('userId') userId: string,
    @Param() params: IdParamDto,
    @Body() dto: AdminUpdateDriverDto,
  ): Promise<AdminDriverDetailDto> {
    return this.drivers.update(userId, params.id, dto);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('drivers.approve')
  @ResponseCodeMeta(ResponseCode.DRIVER_APPROVED)
  @ApiOperation({
    summary: 'Admit a driver to the platform',
    description:
      'Refused while any required document is unreviewed or rejected — approving a driver whose licence nobody has read is the mistake this screen exists to prevent. The driver is notified and can go online immediately.',
  })
  @ApiSuccessResponse({ code: ResponseCode.DRIVER_APPROVED, type: AdminDriverDetailDto })
  @ApiErrorResponses(
    { status: 404, code: ResponseCode.DRIVER_NOT_FOUND },
    { status: 409, code: ResponseCode.DRIVER_ALREADY_APPROVED },
    { status: 422, code: ResponseCode.DRIVER_DOCUMENTS_INCOMPLETE },
  )
  approve(@CurrentUser('userId') userId: string, @Param() params: IdParamDto): Promise<AdminDriverDetailDto> {
    return this.drivers.approve(userId, params.id);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('drivers.approve')
  @ResponseCodeMeta(ResponseCode.DRIVER_REJECTED_DECISION)
  @ApiOperation({
    summary: 'Turn down an application',
    description: 'The reason is shown to the driver. They are taken out of the matching pool immediately.',
  })
  @ApiSuccessResponse({ code: ResponseCode.DRIVER_REJECTED_DECISION, type: AdminDriverDetailDto })
  @ApiErrorResponses({ status: 404, code: ResponseCode.DRIVER_NOT_FOUND })
  reject(
    @CurrentUser('userId') userId: string,
    @Param() params: IdParamDto,
    @Body() dto: AdminReasonDto,
  ): Promise<AdminDriverDetailDto> {
    return this.drivers.reject(userId, params.id, dto);
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('drivers.suspend')
  @ResponseCodeMeta(ResponseCode.DRIVER_SUSPENDED_DECISION)
  @ApiOperation({
    summary: 'Stop a driver working, and signing in',
    description:
      'Takes them out of the matching pool, revokes every open session and blocks login. Refused while they are holding a delivery — the package is physically with them, so the operator reassigns or cancels first.',
  })
  @ApiSuccessResponse({ code: ResponseCode.DRIVER_SUSPENDED_DECISION, type: AdminDriverDetailDto })
  @ApiErrorResponses(
    { status: 404, code: ResponseCode.DRIVER_NOT_FOUND },
    { status: 409, code: ResponseCode.DRIVER_HAS_ACTIVE_DELIVERY },
  )
  suspend(
    @CurrentUser('userId') userId: string,
    @Param() params: IdParamDto,
    @Body() dto: AdminReasonDto,
  ): Promise<AdminDriverDetailDto> {
    return this.drivers.suspend(userId, params.id, dto);
  }

  @Post(':id/reinstate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('drivers.suspend')
  @ResponseCodeMeta(ResponseCode.DRIVER_REINSTATED)
  @ApiOperation({
    summary: 'Lift a suspension',
    description: 'The driver can sign in again and go online, subject to the usual readiness checks.',
  })
  @ApiSuccessResponse({ code: ResponseCode.DRIVER_REINSTATED, type: AdminDriverDetailDto })
  @ApiErrorResponses(
    { status: 404, code: ResponseCode.DRIVER_NOT_FOUND },
    { status: 409, code: ResponseCode.DRIVER_NOT_SUSPENDED },
  )
  reinstate(
    @CurrentUser('userId') userId: string,
    @Param() params: IdParamDto,
  ): Promise<AdminDriverDetailDto> {
    return this.drivers.reinstate(userId, params.id);
  }

  @Get(':id/documents')
  @RequirePermissions('drivers.view')
  @ResponseCodeMeta(ResponseCode.DRIVER_DOCUMENTS_FETCHED)
  @ApiOperation({
    summary: 'Documents submitted by a driver',
    description: 'Each carries a time-limited link to the file, and whether the driver cannot work without it.',
  })
  @ApiSuccessResponse({
    code: ResponseCode.DRIVER_DOCUMENTS_FETCHED,
    type: AdminDriverDocumentDto,
    isArray: true,
  })
  @ApiErrorResponses({ status: 404, code: ResponseCode.DRIVER_NOT_FOUND })
  documents(@Param() params: IdParamDto): Promise<AdminDriverDocumentDto[]> {
    return this.drivers.documents(params.id);
  }

  @Post(':id/documents/:documentId/review')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('drivers.approve')
  @ResponseCodeMeta(ResponseCode.DOCUMENT_REVIEWED)
  @ApiParam({ name: 'documentId', description: 'The document being decided on.' })
  @ApiOperation({
    summary: 'Accept or refuse one document',
    description:
      'Rejecting requires a note, which the driver is shown. If refusing it leaves an already-active driver unable to work, they are taken offline in the same breath rather than left working on a document that has just been refused.',
  })
  @ApiSuccessResponse({
    code: ResponseCode.DOCUMENT_REVIEWED,
    type: AdminDriverDocumentDto,
    isArray: true,
  })
  @ApiErrorResponses(
    { status: 400, code: ResponseCode.VALIDATION_ERROR },
    { status: 404, code: ResponseCode.DOCUMENT_NOT_FOUND },
  )
  reviewDocument(
    @CurrentUser('userId') userId: string,
    @Param('id') driverId: string,
    @Param('documentId') documentId: string,
    @Body() dto: AdminReviewDocumentDto,
  ): Promise<AdminDriverDocumentDto[]> {
    return this.drivers.reviewDocument(userId, driverId, documentId, dto);
  }

  @Put(':id/zones')
  @RequirePermissions('drivers.edit')
  @ResponseCodeMeta(ResponseCode.DRIVER_ZONES_UPDATED)
  @ApiOperation({
    summary: 'Set which zones a driver covers',
    description: 'Replaces the assignment outright. An empty list clears it.',
  })
  @ApiSuccessResponse({
    code: ResponseCode.DRIVER_ZONES_UPDATED,
    type: AdminZoneSummaryDto,
    isArray: true,
  })
  @ApiErrorResponses(
    { status: 404, code: ResponseCode.DRIVER_NOT_FOUND },
    { status: 404, code: ResponseCode.ZONE_NOT_FOUND },
  )
  assignZones(
    @CurrentUser('userId') userId: string,
    @Param() params: IdParamDto,
    @Body() dto: AdminAssignZonesDto,
  ): Promise<AdminZoneSummaryDto[]> {
    return this.drivers.assignZones(userId, params.id, dto);
  }
}
