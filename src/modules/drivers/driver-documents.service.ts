import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import { CryptoUtil } from '../../common/utils/crypto.util.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
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

const DAY_MS = 86_400_000;

/** The documents with an upload purpose of their own, named for the form field they fill. */
const PURPOSE_BY_TYPE: Partial<Record<DriverDocumentType, FilePurpose>> = {
  [DriverDocumentType.NATIONAL_ID_FRONT]: FilePurpose.NATIONAL_ID,
  [DriverDocumentType.NATIONAL_ID_BACK]: FilePurpose.NATIONAL_ID,
  [DriverDocumentType.DRIVER_LICENSE_FRONT]: FilePurpose.DRIVING_LICENSE,
  [DriverDocumentType.DRIVER_LICENSE_BACK]: FilePurpose.DRIVING_LICENSE,
  [DriverDocumentType.CERTIFICATE_OF_REGISTRY]: FilePurpose.CERTIFICATE_OF_REGISTRY,
};

const documentSelect = {
  id: true,
  type: true,
  status: true,
  fileId: true,
  documentNumberLast4: true,
  reviewNote: true,
  reviewedAt: true,
  expiresAt: true,
  createdAt: true,
} as const;

type DocumentRow = Prisma.DriverDocumentGetPayload<{ select: typeof documentSelect }>;

/** An expiry date is a day, kept as midnight UTC on it; this gives the day back. */
export function expiryDay(expiresAt: Date | null): string | null {
  return expiresAt ? expiresAt.toISOString().slice(0, 10) : null;
}

@Injectable()
export class DriverDocumentsService {
  private readonly encryptionKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly fileUrls: FileUrlService,
    private readonly uploads: UploadsService,
    config: ConfigService,
  ) {
    this.encryptionKey = config.getOrThrow<string>('app.encryptionKey');
  }

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

    return documents.map((document) => this.toDto(document, urls.get(document.fileId) ?? null));
  }

  /**
   * Submits (or resubmits) a document.
   *
   * A partial unique index allows only one PENDING/APPROVED row per type, so a
   * resubmission supersedes the previous one inside the same transaction rather
   * than colliding with it.
   *
   * The number on the document is encrypted like a bank account number: the
   * operator reviewing it needs it in full to check against the photo, and the
   * app is only ever shown the last four.
   */
  async submit(
    driverId: string,
    userId: string,
    dto: SubmitDriverDocumentDto,
    options: { allowLegacyPurpose?: boolean } = {},
  ): Promise<DriverDocumentDto> {
    await this.assertCanSubmit(userId, dto, options);

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
          ...(dto.documentNumber
            ? {
                documentNumberEnc: CryptoUtil.encrypt(dto.documentNumber, this.encryptionKey),
                documentNumberLast4: dto.documentNumber.slice(-4),
              }
            : {}),
          expiresAt: dto.expiresAt ? new Date(`${dto.expiresAt}T00:00:00.000Z`) : null,
        },
        select: documentSelect,
      });
    });

    return this.toDto(document, await this.fileUrls.resolveById(document.fileId));
  }

  /**
   * Every check submit() makes before it writes: the document has not run out,
   * and its file is the caller's, uploaded as this kind of document. Public so
   * the driver application can make them for every part before saving any.
   */
  async assertCanSubmit(
    userId: string,
    dto: SubmitDriverDocumentDto,
    options: { allowLegacyPurpose?: boolean } = {},
  ): Promise<void> {
    this.assertNotExpired(dto.expiresAt);
    await this.uploads.assertOwnedForPurpose(
      dto.fileId,
      userId,
      this.purposesFor(dto.type, options.allowLegacyPurpose ?? true),
    );
  }

  /**
   * The upload purposes a file may carry to be filed as this type.
   *
   * The national ID, the licence and the certificate each have their own, so
   * a file uploaded as one cannot be filed as another; everything else is a
   * DRIVER_DOCUMENT. That shared purpose is still taken for the three when
   * asked — from builds that uploaded before the split — but not by the
   * application form, which was written for it.
   */
  private purposesFor(type: DriverDocumentType, allowLegacy: boolean): FilePurpose[] {
    const own = PURPOSE_BY_TYPE[type];
    if (!own) return [FilePurpose.DRIVER_DOCUMENT];
    return allowLegacy ? [own, FilePurpose.DRIVER_DOCUMENT] : [own];
  }

  /**
   * Refuses a document that has already run out. It stays valid through the
   * whole of the day printed on it.
   */
  assertNotExpired(expiresAt: string | undefined): void {
    if (!expiresAt) return;

    if (new Date(`${expiresAt}T00:00:00.000Z`).getTime() + DAY_MS <= Date.now()) {
      throw AppException.unprocessable(ResponseCode.DRIVER_DOCUMENT_EXPIRED);
    }
  }

  /**
   * Whether the current submission of this type already says exactly this —
   * the same file, number and expiry. Re-sending the application form must not
   * drag an approved document back into review; a corrected number or date is
   * a new submission, and has to be looked at again.
   */
  async isUnchanged(driverId: string, dto: SubmitDriverDocumentDto): Promise<boolean> {
    const current = await this.prisma.driverDocument.findFirst({
      where: { driverId, type: dto.type, status: { not: DocumentReviewStatus.EXPIRED } },
      orderBy: { createdAt: 'desc' },
      select: { fileId: true, documentNumberEnc: true, expiresAt: true },
    });

    if (!current || current.fileId !== dto.fileId) return false;

    const number = current.documentNumberEnc
      ? CryptoUtil.decrypt(current.documentNumberEnc, this.encryptionKey)
      : undefined;

    return number === dto.documentNumber && (expiryDay(current.expiresAt) ?? undefined) === dto.expiresAt;
  }

  private toDto(document: DocumentRow, fileUrl: string | null): DriverDocumentDto {
    return {
      id: document.id,
      type: document.type,
      label: DOCUMENT_LABELS[document.type],
      status: document.status,
      fileUrl,
      fileUrlExpiresAt: this.fileUrls.expiresAtFor(FileVisibility.PRIVATE),
      documentNumberLast4: document.documentNumberLast4,
      reviewNote: document.reviewNote,
      reviewedAt: document.reviewedAt?.toISOString() ?? null,
      expiresAt: expiryDay(document.expiresAt),
      createdAt: document.createdAt.toISOString(),
      required: REQUIRED.has(document.type),
    };
  }
}
