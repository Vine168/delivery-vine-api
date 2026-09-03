import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { FileVisibility } from '../../generated/prisma/enums.js';

export interface ResolvableFile {
  objectKey: string;
  visibility: FileVisibility;
}

/**
 * Turns stored file metadata into something a mobile client can fetch.
 *
 * Kept separate from UploadsService so any module can render a URL for a file
 * it references (avatars, documents, proof photos) without depending on the
 * upload pipeline.
 */
@Injectable()
export class FileUrlService {
  private readonly signedUrlTtl: number;

  constructor(
    private readonly storage: StorageService,
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.signedUrlTtl = config.get<number>('storage.signedUrlTtlSeconds', 900);
  }

  expiresAtFor(visibility: FileVisibility): string | null {
    return visibility === FileVisibility.PRIVATE
      ? new Date(Date.now() + this.signedUrlTtl * 1000).toISOString()
      : null;
  }

  async resolve(file: ResolvableFile | null | undefined): Promise<string | null> {
    if (!file) return null;
    return this.storage.urlFor(file.objectKey, file.visibility);
  }

  /** Resolves a file referenced only by id, e.g. `CustomerProfile.avatarFileId`. */
  async resolveById(fileId: string | null | undefined): Promise<string | null> {
    if (!fileId) return null;

    const file = await this.prisma.fileAsset.findFirst({
      where: { id: fileId, deletedAt: null },
      select: { objectKey: true, visibility: true },
    });

    return this.resolve(file);
  }

  /**
   * Resolves many ids in one pass — one query, then local URL signing — so a
   * list endpoint never issues a query per row.
   */
  async resolveMany(fileIds: (string | null | undefined)[]): Promise<Map<string, string>> {
    const ids = [...new Set(fileIds.filter((id): id is string => Boolean(id)))];
    if (ids.length === 0) return new Map();

    const files = await this.prisma.fileAsset.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, objectKey: true, visibility: true },
    });

    const entries = await Promise.all(
      files.map(async (file) => [file.id, await this.storage.urlFor(file.objectKey, file.visibility)] as const),
    );

    return new Map(entries);
  }
}
