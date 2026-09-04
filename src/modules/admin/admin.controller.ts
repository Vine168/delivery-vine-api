import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiSuccessResponse } from '../../common/decorators/api-docs.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { ResponseCode as ResponseCodeMeta } from '../../common/decorators/response-code.decorator.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AdminSessionService } from './admin-session.service.js';
import { AdminPermissionDto, AdminSessionDto } from './dto/admin-session.dto.js';
import { RequirePermissions } from './require-permissions.decorator.js';

@ApiTags('Admin')
@Controller({ path: 'admin', version: '1' })
export class AdminController {
  constructor(private readonly session: AdminSessionService) {}

  @Get('me')
  @RequirePermissions('admin.access')
  @ResponseCodeMeta(ResponseCode.PROFILE_FETCHED)
  @ApiOperation({
    summary: 'The signed-in operator',
    description:
      'Identity, role and the permissions this account holds. The dashboard calls this after sign-in to decide which screens to show. Permissions are resolved from the database, so a role revoked moments ago is reflected here even if the token still lists it.',
  })
  @ApiSuccessResponse({ code: ResponseCode.PROFILE_FETCHED, type: AdminSessionDto })
  me(@CurrentUser('userId') userId: string): Promise<AdminSessionDto> {
    return this.session.me(userId);
  }

  @Get('permissions')
  @RequirePermissions('roles.view')
  @ResponseCodeMeta(ResponseCode.FETCHED)
  @ApiOperation({
    summary: 'Every permission the platform recognises',
    description: 'Grouped by module, for building the role editor.',
  })
  @ApiSuccessResponse({ code: ResponseCode.FETCHED, type: AdminPermissionDto, isArray: true })
  listPermissions(): Promise<AdminPermissionDto[]> {
    return this.session.listPermissions();
  }
}
