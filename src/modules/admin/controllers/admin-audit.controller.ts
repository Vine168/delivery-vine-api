import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiPaginatedResponse } from '../../../common/decorators/api-docs.decorator.js';
import { ResponseCode as ResponseCodeMeta } from '../../../common/decorators/response-code.decorator.js';
import { ResponseCode } from '../../../common/constants/response-codes.js';
import type { PaginatedResult } from '../../../common/interfaces/paginated.interface.js';
import { AuditService } from '../audit.service.js';
import { AdminAuditEntryDto, AdminAuditQueryDto } from '../dto/admin-team.dto.js';
import { RequirePermissions } from '../require-permissions.decorator.js';

@ApiTags('Admin — Audit log')
@Controller({ path: 'admin/audit-logs', version: '1' })
export class AdminAuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions('audit.view')
  @ResponseCodeMeta(ResponseCode.AUDIT_LOGS_FETCHED)
  @ApiOperation({
    summary: 'What operators have done',
    description:
      'Every state-changing back-office action, newest first, with the values before and after and the address it came from. Filter by entity to answer “what happened to this delivery?”, or by operator to answer “what has this person been doing?”. The log is written by the platform and is not editable from here.',
  })
  @ApiPaginatedResponse({ code: ResponseCode.AUDIT_LOGS_FETCHED, type: AdminAuditEntryDto })
  findAll(@Query() query: AdminAuditQueryDto): Promise<PaginatedResult<AdminAuditEntryDto>> {
    return this.audit.find({
      page: query.page,
      limit: query.limit,
      skip: query.skip,
      entityType: query.entityType,
      entityId: query.entityId,
      actorUserId: query.actorUserId,
      action: query.action,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    });
  }
}
