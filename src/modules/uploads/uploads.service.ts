import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import { CryptoUtil } from '../../common/utils/crypto.util.js';
import { PrismaService } from '../../database/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { detectFileType } from '../storage/file-signature.util.js';
import { FilePurpose, FileUploadStatus } from '../../generated/prisma/enums.js';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface.js';
import { UPLOAD_RULES } from './upload-rules.js';
import type { FileAssetDto } from './dto/upload.dto.js';
import { FileUrlService } from './file-url.service.js';

export interface IncomingFile {
  buffer: Buffer;
  originalname: string;
  size: number;
  mimetype: string;
}

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly fileUrls: FileUrlService,
  ) {}

  /**
   * Validates and stores one file.
   *
   * Order matters: the declared MIME type is ignored entirely and the buffer is
   * sniffed instead, so a renamed executable cannot become an "avatar".
   */
  async upload(file: IncomingFile | undefined, purpose: FilePurpose, user: AuthenticatedUser): Promise<FileAssetDto> {
    if (!file || file.size === 0) {
      throw AppException.badRequest(ResponseCode.VALIDATION_ERROR, 'A file is required.', [
        { field: 'file', message: 'A file is required.' },
      ]);
    }

    const rule = UPLOAD_RULES[purpose];

    if (!rule.roles.includes(user.role)) {
      throw AppException.forbidden(
        ResponseCode.ROLE_NOT_ALLOWED,
        'Your account type cannot upload this kind of file.',
      );
    }

    if (file.size > rule.maxBytes) {
      throw new AppException(
        ResponseCode.FILE_TOO_LARGE,
        413,
        `This file is larger than the ${Math.round(rule.maxBytes / (1024 * 1024))} MB limit.`,
      );
    }

    const detected = detectFileType(file.buffer);
    if (!detected || !rule.mimeTypes.includes(detected.mimeType)) {
      throw new AppException(
        ResponseCode.FILE_TYPE_NOT_ALLOWED,
        415,
        `Allowed formats: ${rule.mimeTypes.map((type) => type.split('/')[1]).join(', ')}.`,
      );
    }

    const objectKey = this.buildObjectKey(purpose, user.userId, detected.extension);

    await this.storage.put({
      objectKey,
      body: file.buffer,
      mimeType: detected.mimeType,
      visibility: rule.visibility,
      originalFilename: file.originalname,
    });

    const asset = await this.prisma.fileAsset.create({
      data: {
        bucket: this.storage.bucketFor(rule.visibility),
        objectKey,
        purpose,
        visibility: rule.visibility,
        status: FileUploadStatus.UPLOADED,
        mimeType: detected.mimeType,
        sizeBytes: file.size,
        originalFilename: file.originalname?.slice(0, 255),
        checksum: CryptoUtil.sha256(file.buffer.toString('base64')),
        uploadedByUserId: user.userId,
      },
      select: {
        id: true,
        purpose: true,
        visibility: true,
        mimeType: true,
        sizeBytes: true,
        objectKey: true,
        createdAt: true,
      },
    });

    return {
      id: asset.id,
      purpose: asset.purpose,
      visibility: asset.visibility,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      url: (await this.fileUrls.resolve(asset)) ?? '',
      urlExpiresAt: this.fileUrls.expiresAtFor(asset.visibility),
      createdAt: asset.createdAt.toISOString(),
    };
  }

  /** Re-signs a private file whose URL has expired. Owner only. */
  async findOwned(fileId: string, userId: string): Promise<FileAssetDto> {
    const asset = await this.prisma.fileAsset.findFirst({
      where: { id: fileId, uploadedByUserId: userId, deletedAt: null },
      select: {
        id: true,
        purpose: true,
        visibility: true,
        mimeType: true,
        sizeBytes: true,
        objectKey: true,
        createdAt: true,
      },
    });

    if (!asset) {
      throw AppException.notFound(ResponseCode.FILE_NOT_FOUND);
    }

    return {
      id: asset.id,
      purpose: asset.purpose,
      visibility: asset.visibility,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      url: (await this.fileUrls.resolve(asset)) ?? '',
      urlExpiresAt: this.fileUrls.expiresAtFor(asset.visibility),
      createdAt: asset.createdAt.toISOString(),
    };
  }

  /**
   * Confirms a file id supplied by a client is theirs and is the right kind of
   * file, before another module attaches it to a record. Without this, a
   * customer could set their avatar to another user's national ID.
   */
  async assertOwnedForPurpose(fileId: string, userId: string, purposes: FilePurpose[]): Promise<void> {
    const asset = await this.prisma.fileAsset.findFirst({
      where: { id: fileId, uploadedByUserId: userId, purpose: { in: purposes }, deletedAt: null },
      select: { id: true },
    });

    if (!asset) {
      throw AppException.badRequest(ResponseCode.FILE_NOT_FOUND, 'That file does not exist or is not yours.');
    }
  }

  /** Detaches a file: soft-deleted in the database, removed from storage. */
  async discard(fileId: string | null | undefined): Promise<void> {
    if (!fileId) return;

    const asset = await this.prisma.fileAsset.findFirst({
      where: { id: fileId, deletedAt: null },
      select: { id: true, objectKey: true, visibility: true },
    });
    if (!asset) return;

    await this.prisma.fileAsset.update({ where: { id: asset.id }, data: { deletedAt: new Date() } });
    await this.storage.remove(asset.objectKey, asset.visibility);
  }

  /** `driver-document/<userId>/2026-09/<uuid>.pdf` — sharded, unguessable. */
  private buildObjectKey(purpose: FilePurpose, userId: string, extension: string): string {
    const folder = purpose.toLowerCase().replaceAll('_', '-');
    const month = new Date().toISOString().slice(0, 7);
    return `${folder}/${userId}/${month}/${randomUUID()}.${extension}`;
  }
}
