import { Injectable } from '@nestjs/common';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { PrismaService } from '../../database/prisma.service.js';
import { DocumentReviewStatus, DriverApprovalStatus } from '../../generated/prisma/enums.js';
import { DOCUMENT_LABELS, REQUIRED_DRIVER_DOCUMENTS } from './driver.constants.js';
import type { DriverReadinessDto } from './dto/driver-profile.dto.js';

/**
 * The single answer to "may this driver work right now?".
 *
 * The driver profile renders it as a checklist and the availability endpoint
 * enforces it, so the app can never show a green tick for something the server
 * will refuse.
 */
@Injectable()
export class DriverReadinessService {
  constructor(private readonly prisma: PrismaService) {}

  async evaluate(driverId: string): Promise<DriverReadinessDto> {
    const [driver, documents, vehicle] = await Promise.all([
      this.prisma.driverProfile.findUnique({
        where: { id: driverId },
        select: { approvalStatus: true },
      }),
      this.prisma.driverDocument.findMany({
        where: { driverId, status: { in: [DocumentReviewStatus.PENDING, DocumentReviewStatus.APPROVED] } },
        select: { type: true, status: true },
      }),
      this.prisma.driverVehicle.findFirst({
        where: { driverId, isPrimary: true, deletedAt: null },
        select: { id: true, status: true },
      }),
    ]);

    const byType = new Map(documents.map((document) => [document.type, document.status]));

    const requiredDocuments = REQUIRED_DRIVER_DOCUMENTS.map((type) => ({
      type,
      label: DOCUMENT_LABELS[type],
      submitted: byType.has(type),
      status: byType.get(type) ?? null,
    }));

    const blockers: string[] = [];

    switch (driver?.approvalStatus) {
      case DriverApprovalStatus.SUSPENDED:
        blockers.push(ResponseCode.DRIVER_SUSPENDED);
        break;
      case DriverApprovalStatus.REJECTED:
        blockers.push(ResponseCode.DRIVER_REJECTED);
        break;
      case DriverApprovalStatus.PENDING_APPROVAL:
        blockers.push(ResponseCode.DRIVER_NOT_APPROVED);
        break;
      default:
        break;
    }

    if (!vehicle) {
      blockers.push(ResponseCode.DRIVER_VEHICLE_REQUIRED);
    }

    // A document that is still pending review does not let a driver work.
    const approvedTypes = new Set(
      documents.filter((document) => document.status === DocumentReviewStatus.APPROVED).map((d) => d.type),
    );
    if (!REQUIRED_DRIVER_DOCUMENTS.every((type) => approvedTypes.has(type))) {
      blockers.push(ResponseCode.DRIVER_DOCUMENTS_INCOMPLETE);
    }

    return {
      canGoOnline: blockers.length === 0,
      blockers,
      requiredDocuments,
      hasVehicle: vehicle !== null,
    };
  }
}
