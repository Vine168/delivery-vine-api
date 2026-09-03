import { Injectable } from '@nestjs/common';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  DocumentReviewStatus,
  DriverDocumentType,
  FilePurpose,
  FileVisibility,
} from '../../generated/prisma/enums.js';
import { FileUrlService } from '../uploads/file-url.service.js';
import { UploadsService } from '../uploads/uploads.service.js';
import { DOCUMENT_LABELS, REQUIRED_DRIVER_DOCUMENTS } from './driver.constants.js';
import type { DriverDocumentDto, SubmitDriverDocumentDto } from './dto/driver-document.dto.js';

const REQUIRED = new Set<DriverDocumentType>(REQUIRED_DRIVER_DOCUMENTS);

const documentSelect = {
  id: true,
  type: true,
  status: true,
  fileId: true,
  reviewNote: true,
  reviewedAt: true,
  expiresAt: true,
  createdAt: true,
} as const;

@Injectable()
export class DriverDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fileUrls: FileUrlService,
    private readonly uploads: UploadsService,
  ) {}

  /**
   * Every document the driver has submitted, newest first, each with a fresh
   * presigned URL. Documents are private objects — there is no public link.
   */
  async findAll(driverId: string): Promise<DriverDocumentDto[]> {
    const documents = await this.prisma.driverDocument.findMany({
      where: { driverId },
      orderBy: [{ type: 'asc' }, { createdAt: 'desc' }],
      select: documentSelect,
    });

    const urls = await this.fileUrls.resolveMany(documents.map((document) => document.fileId));
    const expiresAt = this.fileUrls.expiresAtFor(FileVisibility.PRIVATE);

    return documents.map((document) => ({
      id: document.id,
      type: document.type,
      label: DOCUMENT_LABELS[document.type],
      status: document.status,
      fileUrl: urls.get(document.fileId) ?? null,
      fileUrlExpiresAt: expiresAt,
      reviewNote: document.reviewNote,
      reviewedAt: document.reviewedAt?.toISOString() ?? null,
      expiresAt: document.expiresAt?.toISOString() ?? null,
      createdAt: document.createdAt.toISOString(),
      required: REQUIRED.has(document.type),
    }));
  }

  /**
   * Submits (or resubmits) a document.
   *
   * A partial unique index allows only one PENDING/APPROVED row per type, so a
   * resubmission supersedes the previous one inside the same transaction rather
   * than colliding with it.
   */
  async submit(driverId: string, userId: string, dto: SubmitDriverDocumentDto): Promise<DriverDocumentDto> {
    await this.uploads.assertOwnedForPurpose(dto.fileId, userId, [FilePurpose.DRIVER_DOCUMENT]);

    const document = await this.prisma.$transaction(async (tx) => {
      await tx.driverDocument.updateMany({
        where: {
          driverId,
          type: dto.type,
          status: { in: [DocumentReviewStatus.PENDING, DocumentReviewStatus.APPROVED] },
        },
        data: { status: DocumentReviewStatus.EXPIRED },
      });

      return tx.driverDocument.create({
        data: {
          driverId,
          type: dto.type,
          fileId: dto.fileId,
          status: DocumentReviewStatus.PENDING,
        },
        select: documentSelect,
      });
    });

    return {
      id: document.id,
      type: document.type,
      label: DOCUMENT_LABELS[document.type],
      status: document.status,
      fileUrl: await this.fileUrls.resolveById(document.fileId),
      fileUrlExpiresAt: this.fileUrls.expiresAtFor(FileVisibility.PRIVATE),
      reviewNote: document.reviewNote,
      reviewedAt: document.reviewedAt?.toISOString() ?? null,
      expiresAt: document.expiresAt?.toISOString() ?? null,
      createdAt: document.createdAt.toISOString(),
      required: REQUIRED.has(document.type),
    };
  }

  async findOne(driverId: string, id: string): Promise<DriverDocumentDto> {
    const document = await this.prisma.driverDocument.findFirst({
      where: { id, driverId },
      select: documentSelect,
    });

    if (!document) {
      throw AppException.notFound(ResponseCode.DRIVER_DOCUMENT_NOT_FOUND);
    }

    return {
      id: document.id,
      type: document.type,
      label: DOCUMENT_LABELS[document.type],
      status: document.status,
      fileUrl: await this.fileUrls.resolveById(document.fileId),
      fileUrlExpiresAt: this.fileUrls.expiresAtFor(FileVisibility.PRIVATE),
      reviewNote: document.reviewNote,
      reviewedAt: document.reviewedAt?.toISOString() ?? null,
      expiresAt: document.expiresAt?.toISOString() ?? null,
      createdAt: document.createdAt.toISOString(),
      required: REQUIRED.has(document.type),
    };
  }
}
