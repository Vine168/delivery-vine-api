import { Injectable } from '@nestjs/common';
import { IN_FLIGHT_DELIVERY_STATUSES } from '../../common/constants/delivery-status.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  DocumentReviewStatus,
  FilePurpose,
} from '../../generated/prisma/enums.js';
import { FileUrlService } from '../uploads/file-url.service.js';
import { UploadsService } from '../uploads/uploads.service.js';
import { VehicleTypesService } from '../vehicle-types/vehicle-types.service.js';
import type {
  DriverVehicleDto,
  UpsertDriverVehicleDto,
} from './dto/driver-vehicle.dto.js';

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
   * Every check upsert() makes before it writes — an active vehicle type, and
   * a photo that is the caller's own vehicle photo. Returns the type. Public so
   * the driver application can make them before saving any of its parts.
   */
  async assertValid(userId: string, dto: UpsertDriverVehicleDto) {
    const vehicleType = await this.vehicleTypes.findActiveOrThrow(dto.vehicleTypeId);

    if (!dto.photoFileId || !dto.photoFileId.trim()) {
      throw AppException.unprocessable(
        ResponseCode.DRIVER_VEHICLE_PHOTO_REQUIRED,
        'Please upload a clear vehicle photo before saving the vehicle.',
      );
    }

    await this.uploads.assertOwnedForPurpose(dto.photoFileId, userId, [FilePurpose.VEHICLE_PHOTO]);

    return vehicleType;
  }

  /**
   * Creates the driver's vehicle, or updates it in place.
   *
   * Any change puts the vehicle back into review — a driver cannot swap to an
   * unverified plate while keeping an approved status. Sending the same details
   * again is not a change and leaves the review where it was. Changing vehicle
   * type is refused mid-delivery, since the customer booked a specific type.
   */
  async upsert(
    driverId: string,
    userId: string,
    dto: UpsertDriverVehicleDto,
  ): Promise<DriverVehicleDto> {
    const vehicleType = await this.assertValid(userId, dto);

    const existing = await this.prisma.driverVehicle.findFirst({
      where: { driverId, isPrimary: true, deletedAt: null },
      select: vehicleSelect,
    });

    // The app re-saves the whole form. Sending back exactly what an operator
    // already reviewed is not a change, and resetting the review for it would
    // take an approved driver off the road for tapping "Save".
    if (existing && this.isUnchanged(existing, vehicleType.id, dto)) {
      return this.toDto(existing);
    }

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
      photoFileId: dto.photoFileId,
      status: DocumentReviewStatus.PENDING,
      reviewNote: null,
    };

    await this.assertPlateAvailable(driverId, dto.plateNumber, existing?.id);

    const vehicle = existing
      ? await this.prisma.driverVehicle.update({
          where: { id: existing.id },
          data,
          select: vehicleSelect,
        })
      : await this.prisma.driverVehicle.create({
          data: { ...data, driverId, isPrimary: true },
          select: vehicleSelect,
        });

    if (existing?.photoFileId && existing.photoFileId !== dto.photoFileId) {
      await this.uploads.discard(existing.photoFileId);
    }

    return this.toDto(vehicle);
  }

  /**
   * Whether the request leaves every reviewed detail as it is. An optional
   * field left out of the body is not a change — the update skips it.
   */
  private isUnchanged(
    current: {
      vehicleTypeId: string;
      plateNumber: string;
      brand: string | null;
      model: string | null;
      color: string | null;
      year: number | null;
      photoFileId: string | null;
    },
    vehicleTypeId: string,
    dto: UpsertDriverVehicleDto,
  ): boolean {
    const same = <T>(sent: T | undefined, stored: T | null) => sent === undefined || sent === stored;

    return (
      current.vehicleTypeId === vehicleTypeId &&
      current.plateNumber === dto.plateNumber &&
      current.photoFileId === dto.photoFileId &&
      same(dto.brand, current.brand) &&
      same(dto.model, current.model) &&
      same(dto.color, current.color) &&
      same(dto.year, current.year)
    );
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

  private async assertPlateAvailable(
    driverId: string,
    plateNumber: string,
    exceptId?: string,
  ): Promise<void> {
    const clash = await this.prisma.driverVehicle.findFirst({
      where: {
        driverId,
        plateNumber,
        ...(exceptId ? { NOT: { id: exceptId } } : {}),
      },
      select: { id: true },
    });

    if (clash) {
      throw AppException.conflict(
        ResponseCode.CONFLICT,
        'You have already registered that plate number.',
      );
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
