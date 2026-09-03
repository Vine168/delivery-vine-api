import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponses, ApiSuccessResponse } from '../../common/decorators/api-docs.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { ResponseCode as ResponseCodeMeta } from '../../common/decorators/response-code.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { IdParamDto } from '../../common/dto/id-param.dto.js';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface.js';
import { UserRole } from '../../generated/prisma/enums.js';
import { DriverDocumentsService } from './driver-documents.service.js';
import { DriverProfileService } from './driver-profile.service.js';
import { DriverVehicleService } from './driver-vehicle.service.js';
import { DriverDocumentDto, SubmitDriverDocumentDto } from './dto/driver-document.dto.js';
import { DriverProfileDto, UpdateDriverAvatarDto, UpdateDriverProfileDto } from './dto/driver-profile.dto.js';
import { DriverVehicleDto, UpsertDriverVehicleDto } from './dto/driver-vehicle.dto.js';

@ApiTags('Driver Profile')
@ApiBearerAuth()
@Roles(UserRole.DRIVER)
@Controller({ path: 'mobile/driver', version: '1' })
export class DriversController {
  constructor(
    private readonly profiles: DriverProfileService,
    private readonly vehicles: DriverVehicleService,
    private readonly documents: DriverDocumentsService,
  ) {}

  // ── Profile ────────────────────────────────────────────────────────────

  @Get('profile')
  @ResponseCodeMeta(ResponseCode.DRIVER_PROFILE_FETCHED)
  @ApiOperation({
    summary: 'Get the signed-in driver profile',
    description:
      'Includes `readiness`: whether the driver may go online, and the exact blockers if not. The driver app should render this as the onboarding checklist.',
  })
  @ApiSuccessResponse({ code: ResponseCode.DRIVER_PROFILE_FETCHED, type: DriverProfileDto })
  @ApiErrorResponses({ status: 403, code: ResponseCode.ROLE_NOT_ALLOWED })
  getProfile(@CurrentUser('driverId') driverId: string): Promise<DriverProfileDto> {
    return this.profiles.getProfile(driverId);
  }

  @Patch('profile')
  @ResponseCodeMeta(ResponseCode.DRIVER_PROFILE_UPDATED)
  @ApiOperation({
    summary: 'Update the driver profile',
    description: 'Approval status and ratings are set by the platform and cannot be changed here.',
  })
  @ApiSuccessResponse({ code: ResponseCode.DRIVER_PROFILE_UPDATED, type: DriverProfileDto })
  @ApiErrorResponses(
    { status: 400, code: ResponseCode.VALIDATION_ERROR },
    { status: 409, code: ResponseCode.CONFLICT, description: 'That email address is already in use.' },
  )
  updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateDriverProfileDto,
  ): Promise<DriverProfileDto> {
    return this.profiles.updateProfile(user.driverId as string, user.userId, dto);
  }

  @Post('profile/avatar')
  @HttpCode(HttpStatus.OK)
  @ResponseCodeMeta(ResponseCode.AVATAR_UPDATED)
  @ApiOperation({ summary: 'Set the driver photo' })
  @ApiSuccessResponse({ code: ResponseCode.AVATAR_UPDATED, type: DriverProfileDto })
  @ApiErrorResponses({ status: 400, code: ResponseCode.FILE_NOT_FOUND })
  setAvatar(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateDriverAvatarDto): Promise<DriverProfileDto> {
    return this.profiles.setAvatar(user.driverId as string, user.userId, dto.fileId);
  }

  // ── Vehicle ────────────────────────────────────────────────────────────

  @Get('vehicle')
  @ResponseCodeMeta(ResponseCode.DRIVER_VEHICLE_FETCHED)
  @ApiOperation({ summary: 'Get the registered vehicle' })
  @ApiSuccessResponse({ code: ResponseCode.DRIVER_VEHICLE_FETCHED, type: DriverVehicleDto })
  @ApiErrorResponses({ status: 404, code: ResponseCode.DRIVER_VEHICLE_NOT_FOUND })
  getVehicle(@CurrentUser('driverId') driverId: string): Promise<DriverVehicleDto> {
    return this.vehicles.getPrimary(driverId);
  }

  @Patch('vehicle')
  @ResponseCodeMeta(ResponseCode.DRIVER_VEHICLE_UPDATED)
  @ApiOperation({
    summary: 'Register or update the vehicle',
    description:
      'Creates the vehicle if the driver has none. Any change returns it to PENDING review, and the vehicle type cannot change while a delivery is in flight.',
  })
  @ApiSuccessResponse({ code: ResponseCode.DRIVER_VEHICLE_UPDATED, type: DriverVehicleDto })
  @ApiErrorResponses(
    { status: 404, code: ResponseCode.VEHICLE_TYPE_NOT_FOUND },
    { status: 409, code: ResponseCode.DRIVER_HAS_ACTIVE_DELIVERY },
    { status: 422, code: ResponseCode.VEHICLE_TYPE_INACTIVE },
  )
  upsertVehicle(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpsertDriverVehicleDto,
  ): Promise<DriverVehicleDto> {
    return this.vehicles.upsert(user.driverId as string, user.userId, dto);
  }

  // ── Documents ──────────────────────────────────────────────────────────

  @Get('documents')
  @ResponseCodeMeta(ResponseCode.DRIVER_DOCUMENTS_FETCHED)
  @ApiOperation({
    summary: 'List submitted documents',
    description: 'Each document carries a presigned URL that expires; call GET /mobile/uploads/:id for a fresh one.',
  })
  @ApiSuccessResponse({ code: ResponseCode.DRIVER_DOCUMENTS_FETCHED, type: DriverDocumentDto, isArray: true })
  getDocuments(@CurrentUser('driverId') driverId: string): Promise<DriverDocumentDto[]> {
    return this.documents.findAll(driverId);
  }

  @Post('documents')
  @HttpCode(HttpStatus.CREATED)
  @ResponseCodeMeta(ResponseCode.DRIVER_DOCUMENT_UPLOADED)
  @ApiOperation({
    summary: 'Submit a document for review',
    description: 'Resubmitting a type supersedes the previous submission. Documents are stored privately.',
  })
  @ApiSuccessResponse({ status: 201, code: ResponseCode.DRIVER_DOCUMENT_UPLOADED, type: DriverDocumentDto })
  @ApiErrorResponses({ status: 400, code: ResponseCode.FILE_NOT_FOUND })
  submitDocument(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SubmitDriverDocumentDto,
  ): Promise<DriverDocumentDto> {
    return this.documents.submit(user.driverId as string, user.userId, dto);
  }

  @Get('documents/:id')
  @ResponseCodeMeta(ResponseCode.FILE_FETCHED)
  @ApiOperation({ summary: 'Get one document with a fresh URL' })
  @ApiSuccessResponse({ code: ResponseCode.FILE_FETCHED, type: DriverDocumentDto })
  @ApiErrorResponses({ status: 404, code: ResponseCode.DRIVER_DOCUMENT_NOT_FOUND })
  getDocument(
    @CurrentUser('driverId') driverId: string,
    @Param() params: IdParamDto,
  ): Promise<DriverDocumentDto> {
    return this.documents.findOne(driverId, params.id);
  }
}
