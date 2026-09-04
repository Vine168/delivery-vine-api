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
import { CurrentAdmin } from '../current-admin.decorator.js';
import { AdminReasonDto } from '../dto/admin-driver.dto.js';
import {
  AdminAdministratorDto,
  AdminCreateAdministratorDto,
  AdminCreateRoleDto,
  AdminResetPasswordDto,
  AdminRoleDto,
  AdminTeamQueryDto,
  AdminUpdateAdministratorDto,
  AdminUpdateRoleDto,
} from '../dto/admin-team.dto.js';
import { RequirePermissions } from '../require-permissions.decorator.js';
import { AdminTeamService } from '../services/admin-team.service.js';

@ApiTags('Admin — Roles')
@Controller({ path: 'admin/roles', version: '1' })
export class AdminRolesController {
  constructor(private readonly team: AdminTeamService) {}

  @Get()
  @RequirePermissions('roles.view')
  @ResponseCodeMeta(ResponseCode.ROLES_FETCHED)
  @ApiOperation({
    summary: 'Roles',
    description:
      'A role is a bundle of permissions. System roles come from the platform’s own catalogue and are read-only; each row shows how many operators hold it.',
  })
  @ApiSuccessResponse({ code: ResponseCode.ROLES_FETCHED, type: AdminRoleDto, isArray: true })
  findAll(): Promise<AdminRoleDto[]> {
    return this.team.findRoles();
  }

  @Get(':id')
  @RequirePermissions('roles.view')
  @ResponseCodeMeta(ResponseCode.ROLE_FETCHED)
  @ApiOperation({ summary: 'One role, with its permissions' })
  @ApiSuccessResponse({ code: ResponseCode.ROLE_FETCHED, type: AdminRoleDto })
  @ApiErrorResponses({ status: 404, code: ResponseCode.ROLE_NOT_FOUND })
  findOne(@Param() params: IdParamDto): Promise<AdminRoleDto> {
    return this.team.findRole(params.id);
  }

  @Post()
  @RequirePermissions('roles.manage')
  @ResponseCodeMeta(ResponseCode.ROLE_CREATED)
  @ApiOperation({
    summary: 'Create a role',
    description:
      'Permissions come from GET /admin/permissions. Include `admin.access` or the role’s holders will not be able to open the back office at all.',
  })
  @ApiSuccessResponse({ status: 201, code: ResponseCode.ROLE_CREATED, type: AdminRoleDto })
  @ApiErrorResponses(
    { status: 409, code: ResponseCode.ROLE_NAME_TAKEN },
    { status: 422, code: ResponseCode.PERMISSION_NOT_FOUND },
  )
  create(@CurrentUser('userId') userId: string, @Body() dto: AdminCreateRoleDto): Promise<AdminRoleDto> {
    return this.team.createRole(userId, dto);
  }

  @Patch(':id')
  @RequirePermissions('roles.manage')
  @ResponseCodeMeta(ResponseCode.ROLE_UPDATED)
  @ApiOperation({
    summary: 'Change a role',
    description:
      'Sending `permissions` replaces the set outright. Everyone holding the role is affected within seconds — their cached access is dropped, not left to expire. System roles are refused: the seed rewrites them from the catalogue, so an edit would be undone on the next deploy.',
  })
  @ApiSuccessResponse({ code: ResponseCode.ROLE_UPDATED, type: AdminRoleDto })
  @ApiErrorResponses(
    { status: 403, code: ResponseCode.ROLE_IS_SYSTEM },
    { status: 404, code: ResponseCode.ROLE_NOT_FOUND },
    { status: 409, code: ResponseCode.ROLE_NAME_TAKEN },
    { status: 422, code: ResponseCode.PERMISSION_NOT_FOUND },
  )
  update(
    @CurrentUser('userId') userId: string,
    @Param() params: IdParamDto,
    @Body() dto: AdminUpdateRoleDto,
  ): Promise<AdminRoleDto> {
    return this.team.updateRole(userId, params.id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('roles.manage')
  @ResponseCodeMeta(ResponseCode.ROLE_DELETED)
  @ApiOperation({
    summary: 'Delete a role',
    description: 'Only one nobody holds — move its operators elsewhere first.',
  })
  @ApiSuccessResponse({ code: ResponseCode.ROLE_DELETED })
  @ApiErrorResponses(
    { status: 403, code: ResponseCode.ROLE_IS_SYSTEM },
    { status: 404, code: ResponseCode.ROLE_NOT_FOUND },
    { status: 409, code: ResponseCode.ROLE_IN_USE },
  )
  async remove(@CurrentUser('userId') userId: string, @Param() params: IdParamDto): Promise<void> {
    await this.team.deleteRole(userId, params.id);
  }
}

@ApiTags('Admin — Administrators')
@Controller({ path: 'admin/administrators', version: '1' })
export class AdminAdministratorsController {
  constructor(private readonly team: AdminTeamService) {}

  @Get()
  @RequirePermissions('admins.view')
  @ResponseCodeMeta(ResponseCode.ADMINS_FETCHED)
  @ApiOperation({
    summary: 'Back-office accounts',
    description: 'Who can sign in, under which role, and when they last did.',
  })
  @ApiPaginatedResponse({ code: ResponseCode.ADMINS_FETCHED, type: AdminAdministratorDto })
  findAll(@Query() query: AdminTeamQueryDto): Promise<PaginatedResult<AdminAdministratorDto>> {
    return this.team.findAdministrators(query);
  }

  @Get(':id')
  @RequirePermissions('admins.view')
  @ResponseCodeMeta(ResponseCode.ADMIN_FETCHED)
  @ApiOperation({ summary: 'One operator' })
  @ApiSuccessResponse({ code: ResponseCode.ADMIN_FETCHED, type: AdminAdministratorDto })
  @ApiErrorResponses({ status: 404, code: ResponseCode.ADMIN_NOT_FOUND })
  findOne(@Param() params: IdParamDto): Promise<AdminAdministratorDto> {
    return this.team.findAdministrator(params.id);
  }

  @Post()
  @RequirePermissions('admins.manage')
  @ResponseCodeMeta(ResponseCode.ADMIN_CREATED)
  @ApiOperation({
    summary: 'Add an operator',
    description:
      'There is no self-registration for the back office, so the creating operator sets the first password and hands it over. It is hashed at once and never returned by any endpoint, including this one. New accounts are never created as super admins — that is granted separately, by a super admin.',
  })
  @ApiSuccessResponse({ status: 201, code: ResponseCode.ADMIN_CREATED, type: AdminAdministratorDto })
  @ApiErrorResponses(
    { status: 400, code: ResponseCode.VALIDATION_ERROR },
    { status: 404, code: ResponseCode.ROLE_NOT_FOUND },
    { status: 409, code: ResponseCode.ACCOUNT_ALREADY_EXISTS },
  )
  create(
    @CurrentUser('userId') userId: string,
    @Body() dto: AdminCreateAdministratorDto,
  ): Promise<AdminAdministratorDto> {
    return this.team.create(userId, dto);
  }

  @Patch(':id')
  @RequirePermissions('admins.manage')
  @ResponseCodeMeta(ResponseCode.ADMIN_UPDATED)
  @ApiOperation({
    summary: 'Change an operator’s details or role',
    description:
      'Unrestricted access can only be granted by someone who already has it, and never on your own account — otherwise `admins.manage` would be a route to every permission on the platform. You cannot change your own role either.',
  })
  @ApiSuccessResponse({ code: ResponseCode.ADMIN_UPDATED, type: AdminAdministratorDto })
  @ApiErrorResponses(
    { status: 403, code: ResponseCode.SUPER_ADMIN_REQUIRED },
    { status: 403, code: ResponseCode.CANNOT_MODIFY_SELF },
    { status: 404, code: ResponseCode.ADMIN_NOT_FOUND },
    { status: 409, code: ResponseCode.LAST_SUPER_ADMIN },
  )
  update(
    @CurrentUser('userId') userId: string,
    @CurrentAdmin('isSuperAdmin') isSuperAdmin: boolean,
    @Param() params: IdParamDto,
    @Body() dto: AdminUpdateAdministratorDto,
  ): Promise<AdminAdministratorDto> {
    return this.team.update(userId, isSuperAdmin, params.id, dto);
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('admins.manage')
  @ResponseCodeMeta(ResponseCode.ADMIN_SUSPENDED)
  @ApiOperation({
    summary: 'Stop an operator signing in',
    description:
      'Ends every open session immediately. Refused on your own account and on the last super admin — both lock everyone out of the back office with a single click, and neither has a way back short of database access.',
  })
  @ApiSuccessResponse({ code: ResponseCode.ADMIN_SUSPENDED, type: AdminAdministratorDto })
  @ApiErrorResponses(
    { status: 403, code: ResponseCode.CANNOT_MODIFY_SELF },
    { status: 404, code: ResponseCode.ADMIN_NOT_FOUND },
    { status: 409, code: ResponseCode.LAST_SUPER_ADMIN },
  )
  suspend(
    @CurrentUser('userId') userId: string,
    @Param() params: IdParamDto,
    @Body() dto: AdminReasonDto,
  ): Promise<AdminAdministratorDto> {
    return this.team.suspend(userId, params.id, dto.reason);
  }

  @Post(':id/reinstate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('admins.manage')
  @ResponseCodeMeta(ResponseCode.ADMIN_REINSTATED)
  @ApiOperation({ summary: 'Let a suspended operator back in' })
  @ApiSuccessResponse({ code: ResponseCode.ADMIN_REINSTATED, type: AdminAdministratorDto })
  @ApiErrorResponses(
    { status: 404, code: ResponseCode.ADMIN_NOT_FOUND },
    { status: 409, code: ResponseCode.CONFLICT },
  )
  reinstate(
    @CurrentUser('userId') userId: string,
    @Param() params: IdParamDto,
  ): Promise<AdminAdministratorDto> {
    return this.team.reinstate(userId, params.id);
  }

  @Post(':id/reset-password')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('admins.manage')
  @ResponseCodeMeta(ResponseCode.ADMIN_PASSWORD_RESET)
  @ApiOperation({
    summary: 'Set a new password for an operator',
    description:
      'Every session of theirs is revoked with it — if the password had to be reset because it was compromised, leaving the old sessions alive defeats the point. The password never appears in a response or in the audit log.',
  })
  @ApiSuccessResponse({ code: ResponseCode.ADMIN_PASSWORD_RESET, type: AdminAdministratorDto })
  @ApiErrorResponses(
    { status: 400, code: ResponseCode.VALIDATION_ERROR },
    { status: 404, code: ResponseCode.ADMIN_NOT_FOUND },
  )
  resetPassword(
    @CurrentUser('userId') userId: string,
    @Param() params: IdParamDto,
    @Body() dto: AdminResetPasswordDto,
  ): Promise<AdminAdministratorDto> {
    return this.team.resetPassword(userId, params.id, dto);
  }
}
