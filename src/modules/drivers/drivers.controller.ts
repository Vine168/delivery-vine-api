import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponses, ApiSuccessResponse } from '../../common/decorators/api-docs.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { ResponseCode as ResponseCodeMeta } from '../../common/decorators/response-code.decorator.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface.js';
import { DriverDocumentsService } from './driver-documents.service.js';
import { DriverApplicationService } from './driver-application.service.js';
import { DriverProfileService } from './driver-profile.service.js';
import { DriverVehicleService } from './driver-vehicle.service.js';
import { DriverDocumentDto, SubmitDriverDocumentDto } from './dto/driver-document.dto.js';
import { DriverProfileDto, UpdateDriverAvatarDto, UpdateDriverProfileDto } from './dto/driver-profile.dto.js';
import { DriverApplicationDto, SubmitDriverApplicationDto } from './dto/driver-application.dto.js';
import { DriverVehicleDto, UpsertDriverVehicleDto } from './dto/driver-vehicle.dto.js';
import { RequiresDriver, RequiresMobileAccount } from '../../common/decorators/capability.decorator.js';

@ApiTags('Driver Profile')
@ApiBearerAuth()
@RequiresDriver()
@Controller({ path: 'mobile/driver', version: '1' })
export class DriversController {
  constructor(
    private readonly profiles: DriverProfileService,
    private readonly application: DriverApplicationService,
    private readonly vehicles: DriverVehicleService,
    private readonly documents: DriverDocumentsService,
  ) {}

  // ── Application ────────────────────────────────────────────────────────

  @Post('application')
  @HttpCode(HttpStatus.OK)
  // Overrides the controller's driver gate: submitting the form is how an
  // account becomes a driver, so the caller need not be one yet.
  @RequiresMobileAccount()
  @ResponseCodeMeta(ResponseCode.DRIVER_APPLICATION_SUBMITTED)
  @ApiOperation({
    summary: 'Submit the whole driver application',
    description:
      'Takes every part of the form in one body and hands it in for review — the only way an account becomes a driver, and the same account keeps ordering as a customer throughout. Upload the files first: each file id comes from POST /mobile/uploads with the purpose its part names, and any mobile account may upload them. Every part is checked before anything is saved, so a refused form — a wrong file, an inactive vehicle type, an expired document — leaves the account exactly as it was; correct the field and send the form again. On a resend, a document whose file, number and expiry have not changed is left as it is, and so is a vehicle whose details have not. Resending a rejected application puts it back to PENDING_APPROVAL for review; a suspended driver cannot resubmit. Once approved, a driver changes individual details through the per-step endpoints.',
  })
  @ApiSuccessResponse({ code: ResponseCode.DRIVER_APPLICATION_SUBMITTED, type: DriverApplicationDto })
  @ApiErrorResponses(
    { status: 400, code: ResponseCode.VALIDATION_ERROR },
    { status: 400, code: ResponseCode.FILE_NOT_FOUND, description: 'A file id is not yours, or has the wrong purpose.' },
    { status: 403, code: ResponseCode.DRIVER_SUSPENDED },
    { status: 404, code: ResponseCode.VEHICLE_TYPE_NOT_FOUND },
    { status: 409, code: ResponseCode.DRIVER_ALREADY_APPROVED },
    { status: 422, code: ResponseCode.VEHICLE_TYPE_INACTIVE },
    { status: 422, code: ResponseCode.DRIVER_DOCUMENT_EXPIRED },
  )
  submitApplication(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SubmitDriverApplicationDto,
  ): Promise<DriverApplicationDto> {
    return this.application.submit(user.userId, dto);
  }

  @Get('application')
  // Overrides the controller's driver gate: the form is drawn before the
  // account has applied, so the caller need not be a driver yet.
  @RequiresMobileAccount()
  @ResponseCodeMeta(ResponseCode.DRIVER_APPLICATION_FETCHED)
  @ApiOperation({
    summary: 'The driver application screen',
    description:
      'Every row the application screen shows, already decided: what it is called, whether it is required, how far along it is, and where to submit it. One call — the app does not have to stitch the profile, the vehicle and the bank details together, nor decide for itself which blocker belongs to which row. An account that has not applied yet gets a blank form: approvalStatus null, every step NOT_SUBMITTED.',
  })
  @ApiSuccessResponse({ code: ResponseCode.DRIVER_APPLICATION_FETCHED, type: DriverApplicationDto })
  getApplication(@CurrentUser() user: AuthenticatedUser): Promise<DriverApplicationDto> {
    return this.application.findFor(user);
  }


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
    description:
      'Approval status and ratings are set by the platform and cannot be changed here. Neither can the name once the driver is approved: it must match the ID they were approved on.',
  })
  @ApiSuccessResponse({ code: ResponseCode.DRIVER_PROFILE_UPDATED, type: DriverProfileDto })
  @ApiErrorResponses(
    { status: 400, code: ResponseCode.VALIDATION_ERROR },
    { status: 409, code: ResponseCode.CONFLICT, description: 'That email address is already in use.' },
    { status: 409, code: ResponseCode.DRIVER_NAME_LOCKED },
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
      'Creates the vehicle if the driver has none. Any change returns it to PENDING review; sending the same details again leaves the review as it is. The vehicle type cannot change while a delivery is in flight.',
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
    description:
      'Resubmitting a type supersedes the previous submission. Documents are stored privately. `documentNumber` and `expiresAt` are optional here — the application form requires them for the national ID — and a document that has already expired is refused.',
  })
  @ApiSuccessResponse({ status: 201, code: ResponseCode.DRIVER_DOCUMENT_UPLOADED, type: DriverDocumentDto })
  @ApiErrorResponses(
    { status: 400, code: ResponseCode.FILE_NOT_FOUND },
    { status: 422, code: ResponseCode.DRIVER_DOCUMENT_EXPIRED },
  )
  submitDocument(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SubmitDriverDocumentDto,
  ): Promise<DriverDocumentDto> {
    return this.documents.submit(user.driverId as string, user.userId, dto);
  }
}
