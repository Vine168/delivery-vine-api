import { Injectable, Logger } from '@nestjs/common';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import { GeoUtil } from '../../common/utils/geo.util.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  ActorType,
  AssignmentStatus,
  DeliveryStatus,
  EarningStatus,
  FilePurpose,
  PaymentMethod,
  PaymentStatus,
} from '../../generated/prisma/enums.js';
import { DriverAvailabilityService } from '../driver-presence/driver-availability.service.js';
import { FileUrlService } from '../uploads/file-url.service.js';
import { UploadsService } from '../uploads/uploads.service.js';
import { DeliveryStateService } from './delivery-state.service.js';
import type {
  ArrivedDto,
  CompleteDeliveryDto,
  ConfirmPickupDto,
  ProofOfDeliveryDto,
  ProofOfDeliveryViewDto,
  StepLocationDto,
} from './dto/execution.dto.js';

/** Metres from the pickup at which a driver is considered under way. */
const IN_TRANSIT_THRESHOLD_METERS = 150;

/**
 * The driver's side of a delivery: arriving, collecting, delivering, proving
 * it and closing the job.
 *
 * Every step does the same five things — confirm the driver owns the job,
 * validate the transition against the state machine, write the change and its
 * history row in one transaction, do whatever else that step owes (a proof
 * record, an earning snapshot, freeing the driver), and announce it after the
 * commit.
 */
@Injectable()
export class DeliveryExecutionService {
  private readonly logger = new Logger(DeliveryExecutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly state: DeliveryStateService,
    private readonly uploads: UploadsService,
    private readonly fileUrls: FileUrlService,
    private readonly availability: DriverAvailabilityService,
  ) {}

  async arriveAtPickup(driverId: string, userId: string, deliveryId: string, dto: ArrivedDto): Promise<void> {
    await this.assertAssigned(driverId, deliveryId);

    const result = await this.prisma.$transaction((tx) =>
      this.state.transition(tx, {
        deliveryId,
        to: DeliveryStatus.ARRIVED_PICKUP,
        actorType: ActorType.DRIVER,
        actorUserId: userId,
        expectedFrom: [DeliveryStatus.DRIVER_ASSIGNED],
        metadata: this.locationMetadata(dto),
      }),
    );

    await this.state.publish(result);
  }

  async confirmPickup(driverId: string, userId: string, deliveryId: string, dto: ConfirmPickupDto): Promise<void> {
    await this.assertAssigned(driverId, deliveryId);

    const result = await this.prisma.$transaction((tx) =>
      this.state.transition(tx, {
        deliveryId,
        to: DeliveryStatus.PICKED_UP,
        actorType: ActorType.DRIVER,
        actorUserId: userId,
        expectedFrom: [DeliveryStatus.ARRIVED_PICKUP],
        reason: dto.note,
        metadata: this.locationMetadata(dto),
      }),
    );

    await this.state.publish(result);
  }

  async arriveAtDropoff(driverId: string, userId: string, deliveryId: string, dto: ArrivedDto): Promise<void> {
    await this.assertAssigned(driverId, deliveryId);

    const result = await this.prisma.$transaction((tx) =>
      this.state.transition(tx, {
        deliveryId,
        to: DeliveryStatus.ARRIVED_DROPOFF,
        actorType: ActorType.DRIVER,
        actorUserId: userId,
        // A driver who drove straight there never passed through IN_TRANSIT.
        expectedFrom: [DeliveryStatus.PICKED_UP, DeliveryStatus.IN_TRANSIT],
        metadata: this.locationMetadata(dto),
      }),
    );

    await this.state.publish(result);
  }

  /**
   * Records the proof. Separate from completion on purpose: the driver may
   * retake a blurred photo, and the delivery is not closed until they say so.
   */
  async saveProofOfDelivery(
    driverId: string,
    userId: string,
    deliveryId: string,
    dto: ProofOfDeliveryDto,
  ): Promise<ProofOfDeliveryViewDto> {
    const delivery = await this.assertAssigned(driverId, deliveryId);

    if (delivery.status !== DeliveryStatus.ARRIVED_DROPOFF && delivery.status !== DeliveryStatus.PICKED_UP && delivery.status !== DeliveryStatus.IN_TRANSIT) {
      throw AppException.unprocessable(
        ResponseCode.DELIVERY_INVALID_TRANSITION,
        'Proof of delivery can only be added once the package is with you.',
      );
    }

    await this.uploads.assertOwnedForPurpose(dto.photoFileId, userId, [FilePurpose.PROOF_OF_DELIVERY]);
    if (dto.signatureFileId) {
      await this.uploads.assertOwnedForPurpose(dto.signatureFileId, userId, [FilePurpose.PROOF_OF_DELIVERY]);
    }

    const existing = await this.prisma.proofOfDelivery.findUnique({
      where: { deliveryId },
      select: { id: true, photoFileId: true, signatureFileId: true },
    });

    const data = {
      driverId,
      photoFileId: dto.photoFileId,
      signatureFileId: dto.signatureFileId,
      recipientName: dto.recipientName,
      note: dto.note,
      latitude: dto.latitude,
      longitude: dto.longitude,
      capturedAt: new Date(),
    };

    const proof = existing
      ? await this.prisma.proofOfDelivery.update({ where: { deliveryId }, data, select: proofSelect })
      : await this.prisma.proofOfDelivery.create({ data: { ...data, deliveryId }, select: proofSelect });

    // A retake leaves the old photo orphaned in storage.
    if (existing && existing.photoFileId !== dto.photoFileId) {
      await this.uploads.discard(existing.photoFileId);
    }
    if (existing?.signatureFileId && existing.signatureFileId !== dto.signatureFileId) {
      await this.uploads.discard(existing.signatureFileId);
    }

    if (dto.recipientName) {
      await this.prisma.deliveryRecipient.updateMany({
        where: { deliveryId },
        data: { receivedByName: dto.recipientName },
      });
    }

    return this.toProofView(proof);
  }

  /**
   * Closes the delivery.
   *
   * One transaction covers the transition, the immutable earning snapshot and
   * the cash record. The snapshot stores the amounts as they were: a
   * commission change next month cannot rewrite what this driver was owed.
   * Crediting the wallet is Phase 7's job, which is why the earning starts
   * PENDING.
   */
  async complete(driverId: string, userId: string, deliveryId: string, dto: CompleteDeliveryDto): Promise<void> {
    const delivery = await this.assertAssigned(driverId, deliveryId);

    const proof = await this.prisma.proofOfDelivery.findUnique({
      where: { deliveryId },
      select: { id: true },
    });

    if (!proof) {
      throw AppException.unprocessable(ResponseCode.PROOF_OF_DELIVERY_REQUIRED);
    }

    const collectsCash = delivery.codEnabled && delivery.codAmount !== null;

    if (collectsCash && dto.codCollectedAmount === undefined) {
      throw AppException.badRequest(
        ResponseCode.VALIDATION_ERROR,
        'Confirm how much cash you collected.',
        [{ field: 'codCollectedAmount', message: 'This delivery collects cash on delivery.' }],
      );
    }

    if (collectsCash && dto.codCollectedAmount !== delivery.codAmount) {
      throw AppException.unprocessable(
        ResponseCode.VALIDATION_ERROR,
        `The amount to collect is ${delivery.codAmount}, not ${dto.codCollectedAmount}.`,
      );
    }

    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      const transition = await this.state.transition(tx, {
        deliveryId,
        to: DeliveryStatus.DELIVERED,
        actorType: ActorType.DRIVER,
        actorUserId: userId,
        expectedFrom: [DeliveryStatus.ARRIVED_DROPOFF],
        metadata: this.locationMetadata(dto),
        data: {
          ...(collectsCash ? { codCollectedAt: now } : {}),
          // Cash in hand settles the delivery; card and wallet are settled by
          // their provider, not by the driver arriving.
          ...(delivery.paymentMethod === PaymentMethod.CASH_ON_DELIVERY
            ? { paymentStatus: PaymentStatus.PAID }
            : {}),
        },
      });

      await tx.driverEarning.create({
        data: {
          driverId,
          deliveryId,
          currency: delivery.currency,
          deliveryAmount: delivery.totalAmount,
          commissionPercentBp: delivery.commissionPercentBp,
          commissionAmount: delivery.commissionAmount,
          netAmount: delivery.driverEarningAmount,
          status: EarningStatus.PENDING,
          earnedAt: now,
        },
      });

      await tx.deliveryAssignment.updateMany({
        where: { deliveryId, driverId, status: AssignmentStatus.ACCEPTED },
        data: { status: AssignmentStatus.COMPLETED, respondedAt: now },
      });

      await tx.driverProfile.update({
        where: { id: driverId },
        data: { completedDeliveries: { increment: 1 } },
      });

      return transition;
    });

    // Free the driver for the next job. Done after the commit: if this fails
    // the delivery is still completed and the driver's own next ping or
    // availability call recovers their status.
    await this.availability.setBusy(driverId, false);

    // publish() already emits DELIVERY_COMPLETED for this status.
    await this.state.publish(result);

    this.logger.log(`${result.bookingCode} completed by driver ${driverId}`);
  }

  /**
   * The driver hands the job back.
   *
   * The customer's booking is not cancelled — it returns to the pool and is
   * offered to someone else. Killing a customer's delivery because one driver
   * broke down would be the wrong trade. The driver is not offered this
   * delivery again.
   */
  async releaseJob(driverId: string, userId: string, deliveryId: string, reason: string): Promise<void> {
    const delivery = await this.assertAssigned(driverId, deliveryId);

    if (delivery.status !== DeliveryStatus.DRIVER_ASSIGNED && delivery.status !== DeliveryStatus.ARRIVED_PICKUP) {
      throw AppException.unprocessable(
        ResponseCode.DELIVERY_INVALID_TRANSITION,
        'You already have the package. Contact support to hand this delivery back.',
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const transition = await this.state.transition(tx, {
        deliveryId,
        to: DeliveryStatus.SEARCHING_DRIVER,
        actorType: ActorType.DRIVER,
        actorUserId: userId,
        expectedFrom: [DeliveryStatus.DRIVER_ASSIGNED, DeliveryStatus.ARRIVED_PICKUP],
        reason,
        data: {
          driverId: null,
          driverVehicleId: null,
          assignedAt: null,
          arrivedPickupAt: null,
          searchStartedAt: new Date(),
        },
      });

      // Marked DECLINED, not CANCELLED: this driver opted out and must not be
      // offered the same delivery again.
      await tx.deliveryAssignment.updateMany({
        where: { deliveryId, driverId, status: AssignmentStatus.ACCEPTED },
        data: { status: AssignmentStatus.DECLINED, declineReason: reason, respondedAt: new Date() },
      });

      await tx.driverProfile.update({
        where: { id: driverId },
        data: { cancelledDeliveries: { increment: 1 } },
      });

      return transition;
    });

    await this.availability.setBusy(driverId, false);

    await this.state.publish(result);
    this.logger.warn(`${result.bookingCode} released by driver ${driverId}: ${reason}`);
  }

  /**
   * Moves a collected delivery to IN_TRANSIT once the driver has actually left
   * the pickup. Driven by the location stream rather than a button, so the
   * status reflects where the driver is instead of what the app claims.
   */
  async markInTransitIfMoved(
    deliveryId: string,
    at: { latitude: number; longitude: number },
  ): Promise<void> {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      select: { status: true, pickupLatitude: true, pickupLongitude: true },
    });

    if (delivery?.status !== DeliveryStatus.PICKED_UP) return;

    const distance = GeoUtil.haversineMeters(at, {
      latitude: delivery.pickupLatitude,
      longitude: delivery.pickupLongitude,
    });

    if (distance < IN_TRANSIT_THRESHOLD_METERS) return;

    try {
      const result = await this.prisma.$transaction((tx) =>
        this.state.transition(tx, {
          deliveryId,
          to: DeliveryStatus.IN_TRANSIT,
          actorType: ActorType.SYSTEM,
          expectedFrom: [DeliveryStatus.PICKED_UP],
          reason: 'Driver left the pickup point',
        }),
      );

      await this.state.publish(result);
    } catch (error) {
      // Losing this race is harmless: the driver reported arrival first.
      this.logger.debug(`Could not mark ${deliveryId} in transit: ${String(error)}`);
    }
  }

  async findProof(deliveryId: string): Promise<ProofOfDeliveryViewDto | null> {
    const proof = await this.prisma.proofOfDelivery.findUnique({
      where: { deliveryId },
      select: proofSelect,
    });

    return proof ? this.toProofView(proof) : null;
  }

  // ── Guards and mapping ─────────────────────────────────────────────────

  /** A driver may only act on the delivery they were actually assigned. */
  private async assertAssigned(driverId: string, deliveryId: string) {
    const delivery = await this.prisma.delivery.findFirst({
      where: { id: deliveryId, driverId },
      select: {
        id: true,
        status: true,
        currency: true,
        totalAmount: true,
        commissionAmount: true,
        commissionPercentBp: true,
        driverEarningAmount: true,
        codEnabled: true,
        codAmount: true,
        paymentMethod: true,
      },
    });

    if (!delivery) {
      throw AppException.notFound(ResponseCode.DELIVERY_NOT_ASSIGNED, 'This delivery is not assigned to you.');
    }

    return delivery;
  }

  private locationMetadata(dto: StepLocationDto) {
    return dto.latitude !== undefined && dto.longitude !== undefined
      ? { latitude: dto.latitude, longitude: dto.longitude }
      : undefined;
  }

  private async toProofView(proof: {
    id: string;
    photoFileId: string;
    signatureFileId: string | null;
    recipientName: string | null;
    note: string | null;
    latitude: number | null;
    longitude: number | null;
    capturedAt: Date;
  }): Promise<ProofOfDeliveryViewDto> {
    const [photoUrl, signatureUrl] = await Promise.all([
      this.fileUrls.resolveById(proof.photoFileId),
      this.fileUrls.resolveById(proof.signatureFileId),
    ]);

    return {
      id: proof.id,
      photoUrl: photoUrl ?? '',
      signatureUrl,
      recipientName: proof.recipientName,
      note: proof.note,
      latitude: proof.latitude,
      longitude: proof.longitude,
      capturedAt: proof.capturedAt.toISOString(),
    };
  }
}

const proofSelect = {
  id: true,
  photoFileId: true,
  signatureFileId: true,
  recipientName: true,
  note: true,
  latitude: true,
  longitude: true,
  capturedAt: true,
} as const;
