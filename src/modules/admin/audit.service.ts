import { Injectable, Logger } from '@nestjs/common';
import { RequestContextStore } from '../../common/context/request-context.js';
import { PaginationUtil } from '../../common/utils/pagination.util.js';
import type { PaginatedResult } from '../../common/interfaces/paginated.interface.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';

export interface AuditEntry {
  actorUserId: string;
  action: string;
  entityType: string;
  entityId?: string;
  summary?: string;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
}

export interface AuditQuery {
  page: number;
  limit: number;
  skip: number;
  entityType?: string;
  entityId?: string;
  actorUserId?: string;
  action?: string;
  dateFrom?: string;
  dateTo?: string;
}

/**
 * The record of what operators did.
 *
 * Every state-changing back-office action writes one of these with the values
 * before and after, so a decision — a suspended driver, a rejected payout, a
 * changed commission rate — can be explained months later without reading
 * application logs.
 *
 * Writes never throw into the caller: failing to record an action is bad, but
 * refusing to perform an action the operator already committed to is worse.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    const context = RequestContextStore.get();

    try {
      await this.prisma.auditLog.create({
        data: {
          actorUserId: entry.actorUserId,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
          summary: entry.summary,
          before: entry.before,
          after: entry.after,
          ipAddress: context?.ip,
          userAgent: context?.userAgent,
        },
      });
    } catch (error) {
      this.logger.error(`Could not record audit entry ${entry.action}: ${String(error)}`);
    }
  }

  async find(query: AuditQuery): Promise<PaginatedResult<AuditLogView>> {
    const where: Prisma.AuditLogWhereInput = {
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
      ...(query.action ? { action: { contains: query.action, mode: 'insensitive' } } : {}),
      ...(query.dateFrom || query.dateTo
        ? {
            createdAt: {
              ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
              ...(query.dateTo ? { lte: new Date(query.dateTo) } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
        select: {
          id: true,
          action: true,
          entityType: true,
          entityId: true,
          summary: true,
          before: true,
          after: true,
          ipAddress: true,
          createdAt: true,
          actor: {
            select: {
              id: true,
              adminProfile: { select: { fullName: true } },
            },
          },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return PaginationUtil.paginate(
      rows.map((row) => ({
        id: row.id,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        summary: row.summary,
        before: row.before as Record<string, unknown> | null,
        after: row.after as Record<string, unknown> | null,
        ipAddress: row.ipAddress,
        actorUserId: row.actor?.id ?? null,
        actorName: row.actor?.adminProfile?.fullName ?? 'System',
        createdAt: row.createdAt.toISOString(),
      })),
      query.page,
      query.limit,
      total,
    );
  }
}

export interface AuditLogView {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ipAddress: string | null;
  actorUserId: string | null;
  actorName: string;
  createdAt: string;
}
