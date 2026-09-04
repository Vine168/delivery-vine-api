import { Injectable } from '@nestjs/common';
import { LIMITS } from '../../common/constants/app.constants.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import { PrismaService } from '../../database/prisma.service.js';
import { FilePurpose } from '../../generated/prisma/enums.js';
import { FileUrlService } from '../uploads/file-url.service.js';
import { UploadsService } from '../uploads/uploads.service.js';
import type {
  CreatePackageTemplateDto,
  PackageTemplateDto,
  UpdatePackageTemplateDto,
} from './dto/package-template.dto.js';

const templateSelect = {
  id: true,
  name: true,
  size: true,
  weightKg: true,
  category: true,
  description: true,
  remarks: true,
  photoFileId: true,
  updatedAt: true,
} as const;

/** Saved package presets, so a regular customer does not retype the same thing. */
@Injectable()
export class PackageTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fileUrls: FileUrlService,
    private readonly uploads: UploadsService,
  ) {}

  async findAll(customerId: string): Promise<PackageTemplateDto[]> {
    const templates = await this.prisma.packageTemplate.findMany({
      where: { customerId, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      select: templateSelect,
    });

    const photoUrls = await this.fileUrls.resolveMany(templates.map((template) => template.photoFileId));

    return templates.map((template) => this.toDto(template, photoUrls));
  }

  async create(
    customerId: string,
    userId: string,
    dto: CreatePackageTemplateDto,
  ): Promise<PackageTemplateDto> {
    const existing = await this.prisma.packageTemplate.count({ where: { customerId, deletedAt: null } });

    if (existing >= LIMITS.MAX_PACKAGE_TEMPLATES) {
      throw AppException.unprocessable(
        ResponseCode.VALIDATION_ERROR,
        `You can save up to ${LIMITS.MAX_PACKAGE_TEMPLATES} package templates.`,
      );
    }

    if (dto.photoFileId) {
      await this.uploads.assertOwnedForPurpose(dto.photoFileId, userId, [FilePurpose.PACKAGE_PHOTO]);
    }

    const template = await this.prisma.packageTemplate.create({
      data: { customerId, ...dto },
      select: templateSelect,
    });

    return this.toDto(template, await this.fileUrls.resolveMany([template.photoFileId]));
  }

  async update(
    customerId: string,
    userId: string,
    id: string,
    dto: UpdatePackageTemplateDto,
  ): Promise<PackageTemplateDto> {
    const existing = await this.findOwnedOrThrow(customerId, id);

    if (dto.photoFileId) {
      await this.uploads.assertOwnedForPurpose(dto.photoFileId, userId, [FilePurpose.PACKAGE_PHOTO]);
    }

    const template = await this.prisma.packageTemplate.update({
      where: { id },
      data: { ...dto },
      select: templateSelect,
    });

    if (dto.photoFileId && existing.photoFileId && existing.photoFileId !== dto.photoFileId) {
      await this.uploads.discard(existing.photoFileId);
    }

    return this.toDto(template, await this.fileUrls.resolveMany([template.photoFileId]));
  }

  /**
   * Soft deleted: past deliveries snapshot their packages, but a template the
   * customer is mid-way through using should not vanish underneath them.
   */
  async remove(customerId: string, id: string): Promise<void> {
    await this.findOwnedOrThrow(customerId, id);
    await this.prisma.packageTemplate.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  private async findOwnedOrThrow(customerId: string, id: string) {
    const template = await this.prisma.packageTemplate.findFirst({
      where: { id, customerId, deletedAt: null },
      select: { id: true, photoFileId: true },
    });

    if (!template) {
      throw AppException.notFound(ResponseCode.PACKAGE_TEMPLATE_NOT_FOUND);
    }

    return template;
  }

  private toDto(
    template: {
      id: string;
      name: string;
      size: PackageTemplateDto['size'];
      weightKg: number | null;
      category: string | null;
      description: string | null;
      remarks: string | null;
      photoFileId: string | null;
      updatedAt: Date;
    },
    photoUrls: Map<string, string>,
  ): PackageTemplateDto {
    return {
      id: template.id,
      name: template.name,
      size: template.size,
      weightKg: template.weightKg,
      category: template.category,
      description: template.description,
      remarks: template.remarks,
      photoUrl: template.photoFileId ? (photoUrls.get(template.photoFileId) ?? null) : null,
      updatedAt: template.updatedAt.toISOString(),
    };
  }
}
