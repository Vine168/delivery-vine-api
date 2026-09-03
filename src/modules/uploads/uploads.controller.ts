import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponses, ApiSuccessResponse } from '../../common/decorators/api-docs.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { ResponseCode as ResponseCodeMeta } from '../../common/decorators/response-code.decorator.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { IdParamDto } from '../../common/dto/id-param.dto.js';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface.js';
import { CreateUploadDto, FileAssetDto } from './dto/upload.dto.js';
import { MAX_UPLOAD_BYTES } from './upload-rules.js';
import { UploadsService, type IncomingFile } from './uploads.service.js';

@ApiTags('Uploads')
@ApiBearerAuth()
@Controller({ path: 'mobile/uploads', version: '1' })
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  @ResponseCodeMeta(ResponseCode.FILE_UPLOADED)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload a file',
    description:
      'Returns a file id to attach to a profile, document, package or delivery. The declared content type is ignored — the file is identified by its actual bytes, and size, format and privacy come from the purpose.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'purpose'],
      properties: {
        file: { type: 'string', format: 'binary' },
        purpose: {
          type: 'string',
          enum: [
            'CUSTOMER_AVATAR',
            'DRIVER_AVATAR',
            'VEHICLE_PHOTO',
            'DRIVER_DOCUMENT',
            'KHQR_IMAGE',
            'PACKAGE_PHOTO',
            'PROOF_OF_DELIVERY',
            'CHAT_ATTACHMENT',
          ],
        },
      },
    },
  })
  @ApiSuccessResponse({ status: 201, code: ResponseCode.FILE_UPLOADED, type: FileAssetDto })
  @ApiErrorResponses(
    { status: 400, code: ResponseCode.VALIDATION_ERROR },
    { status: 403, code: ResponseCode.ROLE_NOT_ALLOWED },
    { status: 413, code: ResponseCode.FILE_TOO_LARGE },
    { status: 415, code: ResponseCode.FILE_TYPE_NOT_ALLOWED },
    { status: 503, code: ResponseCode.STORAGE_UNAVAILABLE },
  )
  upload(
    @UploadedFile() file: IncomingFile | undefined,
    @Body() dto: CreateUploadDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<FileAssetDto> {
    return this.uploads.upload(file, dto.purpose, user);
  }

  @Get(':id')
  @ResponseCodeMeta(ResponseCode.FILE_FETCHED)
  @ApiOperation({
    summary: 'Get a fresh URL for one of your files',
    description: 'Private files are served through presigned URLs that expire; call this to mint a new one.',
  })
  @ApiSuccessResponse({ code: ResponseCode.FILE_FETCHED, type: FileAssetDto })
  @ApiErrorResponses({ status: 404, code: ResponseCode.FILE_NOT_FOUND })
  findOne(@Param() params: IdParamDto, @CurrentUser('userId') userId: string): Promise<FileAssetDto> {
    return this.uploads.findOwned(params.id, userId);
  }
}
