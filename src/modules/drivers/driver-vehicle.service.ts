import { Injectable } from '@nestjs/common';
import { IN_FLIGHT_DELIVERY_STATUSES } from '../../common/constants/delivery-status.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import { PrismaService } from '../../database/prisma.service.js';
import { DocumentReviewStatus, FilePurpose } from '../../generated/prisma/enums.js';
import { FileUrlService } from '../uploads/file-url.service.js';
import { UploadsService } from '../uploads/uploads.service.js';
import { VehicleTypesService } from '../vehicle-types/vehicle-types.service.js';
import type { DriverVehicleDto, UpsertDriverVehicleDto } from './dto/driver-vehicle.dto.js';

const vehicleSelect = {
  id: true,
  vehicleTypeId: true,
  plateNumber: true,
  brand: true,
  model: true,
  color: true,
  year: true,
  photoFileId: true,
  status: true,
  reviewNote: true,
  isPrimary: true,
  updatedAt: true,
  vehicleType: { select: { code: true, name: true } },
} as const;

@Injectable()
export class DriverVehicleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fileUrls: FileUrlService,
    private readonly uploads: UploadsService,
    private readonly vehicleTypes: VehicleTypesService,
  ) {}

  async getPrimary(driverId: string): Promise<DriverVehicleDto> {
    const vehicle = await this.prisma.driverVehicle.findFirst({
      where: { driverId, isPrimary: true, deletedAt: null },
      select: vehicleSelect,
    });

    if (!vehicle) {
      throw AppException.notFound(
        ResponseCode.DRIVER_VEHICLE_NOT_FOUND,
        'You have not registered a vehicle yet.',
      );
    }

    return this.toDto(vehicle);
  }

  /**
   * Creates the driver's vehicle, or updates it in place.
   *
   * Any change puts the vehicle back into review — a driver cannot swap to an
   * unverified plate while keeping an approved status. Changing vehicle type is
   * refused mid-delivery, since the customer booked a specific type.
   */
  async upsert(driverId: string, userId: string, dto: UpsertDriverVehicleDto): Promise<DriverVehicleDto> {
    const vehicleType = await this.vehicleTypes.findActiveOrThrow(dto.vehicleTypeId);

    if (dto.photoFileId) {
      await this.uploads.assertOwnedForPurpose(dto.photoFileId, userId, [FilePurpose.VEHICLE_PHOTO]);
    }

    const existing = await this.prisma.driverVehicle.findFirst({
      where: { driverId, isPrimary: true, deletedAt: null },
      select: { id: true, photoFileId: true, vehicleTypeId: true },
    });

    if (existing && existing.vehicleTypeId !== vehicleType.id) {
      await this.assertNoDeliveryInFlight(driverId);
    }

    const data = {
      vehicleTypeId: vehicleType.id,
      plateNumber: dto.plateNumber,
      brand: dto.brand,
      model: dto.model,
      color: dto.color,
      year: dto.year,
      ...(dto.photoFileId ? { photoFileId: dto.photoFileId } : {}),
      status: DocumentReviewStatus.PENDING,
      reviewNote: null,
    };

    await this.assertPlateAvailable(driverId, dto.plateNumber, existing?.id);

    const vehicle = existing
      ? await this.prisma.driverVehicle.update({ where: { id: existing.id }, data, select: vehicleSelect })
      : await this.prisma.driverVehicle.create({
          data: { ...data, driverId, isPrimary: true },
          select: vehicleSelect,
        });

    if (dto.photoFileId && existing?.photoFileId && existing.photoFileId !== dto.photoFileId) {
      await this.uploads.discard(existing.photoFileId);
    }

    return this.toDto(vehicle);
  }

  private async assertNoDeliveryInFlight(driverId: string): Promise<void> {
    const active = await this.prisma.delivery.count({
      where: { driverId, status: { in: [...IN_FLIGHT_DELIVERY_STATUSES] } },
    });

    if (active > 0) {
      throw AppException.conflict(
        ResponseCode.DRIVER_HAS_ACTIVE_DELIVERY,
        'Finish your current delivery before changing vehicle type.',
      );
    }
  }

  private async assertPlateAvailable(driverId: string, plateNumber: string, exceptId?: string): Promise<void> {
    const clash = await this.prisma.driverVehicle.findFirst({
      where: { driverId, plateNumber, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
      select: { id: true },
    });

    if (clash) {
      throw AppException.conflict(ResponseCode.CONFLICT, 'You have already registered that plate number.');
    }
  }

  private async toDto(vehicle: {
    id: string;
    vehicleTypeId: string;
    plateNumber: string;
    brand: string | null;
    model: string | null;
    color: string | null;
    year: number | null;
    photoFileId: string | null;
    status: DocumentReviewStatus;
    reviewNote: string | null;
    isPrimary: boolean;
    updatedAt: Date;
    vehicleType: { code: string; name: string };
  }): Promise<DriverVehicleDto> {
    return {
      id: vehicle.id,
      vehicleTypeId: vehicle.vehicleTypeId,
      vehicleTypeCode: vehicle.vehicleType.code,
      vehicleTypeName: vehicle.vehicleType.name,
      plateNumber: vehicle.plateNumber,
      brand: vehicle.brand,
      model: vehicle.model,
      color: vehicle.color,
      year: vehicle.year,
      photoUrl: await this.fileUrls.resolveById(vehicle.photoFileId),
      status: vehicle.status,
      reviewNote: vehicle.reviewNote,
      isPrimary: vehicle.isPrimary,
      updatedAt: vehicle.updatedAt.toISOString(),
    };
  }
}
