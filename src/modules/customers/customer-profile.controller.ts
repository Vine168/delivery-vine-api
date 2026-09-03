import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponses, ApiSuccessResponse } from '../../common/decorators/api-docs.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { ResponseCode as ResponseCodeMeta } from '../../common/decorators/response-code.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface.js';
import { UserRole } from '../../generated/prisma/enums.js';
import { CustomerProfileService } from './customer-profile.service.js';
import { CustomerProfileDto, UpdateAvatarDto, UpdateCustomerProfileDto } from './dto/customer-profile.dto.js';

@ApiTags('Customer Profile')
@ApiBearerAuth()
@Roles(UserRole.CUSTOMER)
@Controller({ path: 'mobile/customer', version: '1' })
export class CustomerProfileController {
  constructor(private readonly profiles: CustomerProfileService) {}

  @Get('profile')
  @ResponseCodeMeta(ResponseCode.PROFILE_FETCHED)
  @ApiOperation({ summary: 'Get the signed-in customer profile' })
  @ApiSuccessResponse({ code: ResponseCode.PROFILE_FETCHED, type: CustomerProfileDto })
  @ApiErrorResponses({ status: 401, code: ResponseCode.UNAUTHORIZED }, { status: 403, code: ResponseCode.ROLE_NOT_ALLOWED })
  getProfile(@CurrentUser('customerId') customerId: string): Promise<CustomerProfileDto> {
    return this.profiles.getProfile(customerId);
  }

  @Patch('profile')
  @ResponseCodeMeta(ResponseCode.PROFILE_UPDATED)
  @ApiOperation({
    summary: 'Update the customer profile',
    description: 'Phone number changes are not made here — they require OTP verification of the new number.',
  })
  @ApiSuccessResponse({ code: ResponseCode.PROFILE_UPDATED, type: CustomerProfileDto })
  @ApiErrorResponses(
    { status: 400, code: ResponseCode.VALIDATION_ERROR },
    { status: 409, code: ResponseCode.CONFLICT, description: 'That email address is already in use.' },
  )
  updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateCustomerProfileDto,
  ): Promise<CustomerProfileDto> {
    return this.profiles.updateProfile(user.customerId as string, user.userId, dto);
  }

  @Post('profile/avatar')
  @HttpCode(HttpStatus.OK)
  @ResponseCodeMeta(ResponseCode.AVATAR_UPDATED)
  @ApiOperation({
    summary: 'Set the profile photo',
    description: 'Takes a file id from POST /mobile/uploads. The previous avatar is deleted from storage.',
  })
  @ApiSuccessResponse({ code: ResponseCode.AVATAR_UPDATED, type: CustomerProfileDto })
  @ApiErrorResponses({ status: 400, code: ResponseCode.FILE_NOT_FOUND, description: 'That file does not exist or is not yours.' })
  setAvatar(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateAvatarDto): Promise<CustomerProfileDto> {
    return this.profiles.setAvatar(user.customerId as string, user.userId, dto.fileId);
  }

  @Delete('account')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete the account',
    description:
      'Soft deletion. Past deliveries and payments are retained as financial records; the phone number is released so it can be registered again.',
  })
  @ApiErrorResponses({ status: 409, code: ResponseCode.ACCOUNT_HAS_ACTIVE_DELIVERIES })
  async deleteAccount(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.profiles.deleteAccount(user.customerId as string, user.userId);
  }
}
