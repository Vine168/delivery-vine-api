import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import {
  DocumentReviewStatus,
  DriverApprovalStatus,
  DriverDocumentType,
} from '../../generated/prisma/enums.js';
import { DriverReadinessService } from './driver-readiness.service.js';
import { DriverDocumentsService } from './driver-documents.service.js';
import { DriverProfileService } from './driver-profile.service.js';
import { DriverVehicleService } from './driver-vehicle.service.js';
import { WithdrawalsService } from '../withdrawals/withdrawals.service.js';
import { UsersService } from '../users/users.service.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface.js';
import {
  DriverApplicationStep,
  DriverApplicationStepStatus,
  type DriverApplicationDto,
  type DriverApplicationStepDto,
  type SubmitDriverApplicationDto,
} from './dto/driver-application.dto.js';
import type { SubmitDriverDocumentDto } from './dto/driver-document.dto.js';

/** What the driver sees on one row, before its state is worked out. */
interface StepDefinition {
  key: DriverApplicationStep;
  title: string;
  required: boolean;
  endpoint: string;
  /** Documents are read from the same table; the others each have their own. */
  documentType?: DriverDocumentType;
}

/**
 * The application screen in the order it is shown.
 *
 * Required steps first, because a driver who stops reading halfway should have
 * read the ones that matter.
 */
const STEPS: readonly StepDefinition[] = [
  {
    key: DriverApplicationStep.NATIONAL_ID,
    title: 'National ID',
    required: true,
    endpoint: 'POST /mobile/driver/application',
    documentType: DriverDocumentType.NATIONAL_ID_BACK,
  },
  {
    key: DriverApplicationStep.PROFILE_PICTURE,
    title: 'Profile picture',
    required: true,
    endpoint: 'POST /mobile/driver/application',
  },
  {
    key: DriverApplicationStep.VEHICLE,
    title: 'Vehicle detail',
    required: true,
    endpoint: 'POST /mobile/driver/application',
  },
  {
    key: DriverApplicationStep.BANKING,
    title: 'Banking details',
    required: true,
    endpoint: 'POST /mobile/driver/application',
  },
  {
    key: DriverApplicationStep.DRIVING_LICENSE,
    title: 'Driving licence',
    required: false,
    endpoint: 'POST /mobile/driver/application',
    documentType: DriverDocumentType.DRIVER_LICENSE_FRONT,
  },
  {
    key: DriverApplicationStep.CERTIFICATE_OF_REGISTRY,
    title: 'Certificate of registry',
    required: false,
    endpoint: 'POST /mobile/driver/application',
    documentType: DriverDocumentType.CERTIFICATE_OF_REGISTRY,
  },
];

/**
 * One answer for the whole driver application screen.
 *
 * Without this the app has to call three endpoints and then decide for itself
 * that `DRIVER_AVATAR_REQUIRED` belongs to the "Profile picture" row and
 * `DRIVER_VEHICLE_PHOTO_REQUIRED` to the "Vehicle" one — a mapping that lives
 * in the server's rules and would silently rot in the client every time those
 * rules changed. Here the rows come back already decided.
 */
@Injectable()
export class DriverApplicationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: DriverReadinessService,
    private readonly profiles: DriverProfileService,
    private readonly vehicles: DriverVehicleService,
    private readonly documents: DriverDocumentsService,
    private readonly withdrawals: WithdrawalsService,
    private readonly users: UsersService,
  ) {}

  /**
   * Takes the whole application at once and hands it in.
   *
   * This is the only way an account becomes a driver: a caller who has not
   * applied yet is enrolled here, and any mobile account may upload the files
   * the form points at beforehand. Signing up through the driver app enrols
   * too, so for those accounts this fills in what that left blank.
   *
   * Each part is written through the same service the individual endpoint uses,
   * so a rule can never hold on one route and not the other — and every part's
   * checks run before any part is written, so a refused form saves nothing, not
   * even the driver profile. The writes themselves are not one transaction:
   * only an unexpected failure mid-way could leave them part-done, and sending
   * the form again finishes the job. A document already on the account exactly as sent
   * — same file, number and expiry — is left alone rather than resubmitted, so
   * re-sending the form does not drag an approved document back into review;
   * the vehicle upsert leaves an unchanged vehicle's review alone for the same
   * reason. A corrected ID number or date is a new submission, reviewed again.
   *
   * A rejected applicant who sends the form again goes back into the queue:
   * operators work from PENDING_APPROVAL, so leaving them REJECTED would hide the
   * corrected application from the only people who can act on it. A suspended
   * driver cannot resubmit their way out; reinstating them is an operator call.
   */
  async submit(userId: string, dto: SubmitDriverApplicationDto): Promise<DriverApplicationDto> {
    const existing = await this.prisma.driverProfile.findUnique({
      where: { userId },
      select: { id: true, approvalStatus: true },
    });

    if (existing?.approvalStatus === DriverApprovalStatus.ACTIVE) {
      throw AppException.conflict(
        ResponseCode.DRIVER_ALREADY_APPROVED,
        'Your driver account is already approved. Change individual details through their own endpoints.',
      );
    }

    if (existing?.approvalStatus === DriverApprovalStatus.SUSPENDED) {
      throw AppException.forbidden(
        ResponseCode.DRIVER_SUSPENDED,
        'Your driver account is suspended. Contact support to have it reviewed.',
      );
    }

    // Every part is checked before any is saved, so a form refused anywhere
    // leaves the account as it was — no half-made driver profile behind it.
    const documents = this.documentsIn(dto);
    await this.assertValid(userId, existing?.id, dto, documents);

    const driverId = existing?.id ?? (await this.enrol(userId));

    await this.profiles.setAvatar(driverId, userId, dto.avatarFileId);
    await this.vehicles.upsert(driverId, userId, dto.vehicle);
    await this.withdrawals.updateSettings(driverId, userId, dto.banking);

    for (const document of documents) {
      await this.submitDocumentIfNew(driverId, userId, document);
    }

    await this.prisma.driverProfile.update({
      where: { id: driverId },
      data: {
        submittedAt: new Date(),
        ...(existing?.approvalStatus === DriverApprovalStatus.REJECTED
          ? { approvalStatus: DriverApprovalStatus.PENDING_APPROVAL, rejectedReason: null }
          : {}),
      },
    });

    // Applying may have just granted the driver capability; the principal is
    // cached, so the caller's own token has to be told.
    await this.users.invalidateAuthContext(userId);

    return this.get(driverId);
  }

  /**
   * Makes the account a driver, at PENDING_APPROVAL — the one place that does.
   * The name is seeded from the customer side so the profile is not blank; an
   * upsert, so two copies of the form sent at once cannot create two. The
   * caller's cached principal is refreshed at the end of submit().
   */
  private async enrol(userId: string): Promise<string> {
    const customer = await this.prisma.customerProfile.findUnique({
      where: { userId },
      select: { fullName: true },
    });

    const driver = await this.prisma.driverProfile.upsert({
      where: { userId },
      create: { userId, fullName: customer?.fullName ?? '', availability: { create: {} } },
      update: {},
      select: { id: true },
    });

    return driver.id;
  }

  /**
   * Submitting a document supersedes the previous one and sends it back to
   * PENDING, so one already on the account exactly as sent — the same file,
   * number and expiry — is not sent through again.
   */
  private async submitDocumentIfNew(
    driverId: string,
    userId: string,
    document: SubmitDriverDocumentDto,
  ): Promise<void> {
    if (await this.documents.isUnchanged(driverId, document)) return;

    // Strict here: the form names each document, so each file must have been
    // uploaded as that document.
    await this.documents.submit(driverId, userId, document, { allowLegacyPurpose: false });
  }

  /**
   * Every check the parts make before they write, made before any of them
   * does, in the order the form shows them. A document already on file exactly
   * as sent is passed over, as its save would be — it may have been uploaded
   * before each document had a purpose of its own.
   */
  private async assertValid(
    userId: string,
    driverId: string | undefined,
    dto: SubmitDriverApplicationDto,
    documents: SubmitDriverDocumentDto[],
  ): Promise<void> {
    for (const document of documents) {
      if (driverId && (await this.documents.isUnchanged(driverId, document))) continue;
      await this.documents.assertCanSubmit(userId, document, { allowLegacyPurpose: false });
    }

    await this.profiles.assertAvatarFile(userId, dto.avatarFileId);
    await this.vehicles.assertValid(userId, dto.vehicle);
    await this.withdrawals.assertSettingsValid(userId, dto.banking);
  }

  /** The documents the form carries, as the documents service takes them. */
  private documentsIn(dto: SubmitDriverApplicationDto): SubmitDriverDocumentDto[] {
    const { nationalId, drivingLicense, certificateOfRegistry } = dto;

    return [
      {
        type: DriverDocumentType.NATIONAL_ID_BACK,
        fileId: nationalId.fileId,
        documentNumber: nationalId.number,
        expiresAt: nationalId.expiresAt,
      },
      ...(drivingLicense
        ? [
            {
              type: DriverDocumentType.DRIVER_LICENSE_FRONT,
              fileId: drivingLicense.fileId,
              documentNumber: drivingLicense.number,
              expiresAt: drivingLicense.expiresAt,
            },
          ]
        : []),
      ...(certificateOfRegistry
        ? [
            {
              type: DriverDocumentType.CERTIFICATE_OF_REGISTRY,
              fileId: certificateOfRegistry.fileId,
              documentNumber: certificateOfRegistry.number,
              expiresAt: certificateOfRegistry.expiresAt,
            },
          ]
        : []),
    ];
  }

  /**
   * The application screen for this account. One that has not applied yet
   * still gets a form to draw — every row empty — rather than a refusal.
   */
  async findFor(user: AuthenticatedUser): Promise<DriverApplicationDto> {
    return user.driverId ? this.get(user.driverId) : this.blank();
  }

  private blank(): DriverApplicationDto {
    return {
      approvalStatus: null,
      submittedAt: null,
      canSubmit: false,
      canGoOnline: false,
      blockers: [ResponseCode.DRIVER_NOT_ENROLLED],
      steps: STEPS.map((definition) => ({
        key: definition.key,
        title: definition.title,
        required: definition.required,
        status: DriverApplicationStepStatus.NOT_SUBMITTED,
        note: null,
        endpoint: definition.endpoint,
      })),
    };
  }

  async get(driverId: string): Promise<DriverApplicationDto> {
    const [driver, documents, vehicle, bank, readiness] = await Promise.all([
      this.prisma.driverProfile.findUnique({
        where: { id: driverId },
        select: { approvalStatus: true, avatarFileId: true, submittedAt: true },
      }),
      // Newest first so a resubmission is the one that counts.
      this.prisma.driverDocument.findMany({
        where: { driverId },
        select: { type: true, status: true, reviewNote: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.driverVehicle.findFirst({
        where: { driverId, isPrimary: true, deletedAt: null },
        select: { status: true, photoFileId: true, reviewNote: true },
      }),
      this.prisma.driverPaymentSetting.findUnique({
        where: { driverId },
        select: { bankName: true, accountHolderName: true, accountNumberLast4: true },
      }),
      this.readiness.evaluate(driverId),
    ]);

    const latestDocument = new Map<DriverDocumentType, { status: DocumentReviewStatus; reviewNote: string | null }>();
    for (const document of documents) {
      if (!latestDocument.has(document.type)) {
        latestDocument.set(document.type, { status: document.status, reviewNote: document.reviewNote });
      }
    }

    const bankComplete = Boolean(bank?.bankName && bank.accountHolderName && bank.accountNumberLast4);

    const steps = STEPS.map((definition): DriverApplicationStepDto => {
      const { status, note } = this.stateOf(definition, {
        avatarFileId: driver?.avatarFileId ?? null,
        vehicle,
        bankComplete,
        latestDocument,
      });

      return {
        key: definition.key,
        title: definition.title,
        required: definition.required,
        status,
        note,
        endpoint: definition.endpoint,
      };
    });

    return {
      approvalStatus: driver?.approvalStatus as DriverApprovalStatus,
      submittedAt: driver?.submittedAt?.toISOString() ?? null,
      // Submitted, not accepted: the operator decides what happens next.
      canSubmit: steps
        .filter((step) => step.required)
        .every((step) => step.status !== DriverApplicationStepStatus.NOT_SUBMITTED),
      canGoOnline: readiness.canGoOnline,
      blockers: readiness.blockers,
      steps,
    };
  }

  private stateOf(
    definition: StepDefinition,
    state: {
      avatarFileId: string | null;
      vehicle: { status: DocumentReviewStatus; photoFileId: string | null; reviewNote: string | null } | null;
      bankComplete: boolean;
      latestDocument: Map<DriverDocumentType, { status: DocumentReviewStatus; reviewNote: string | null }>;
    },
  ): { status: DriverApplicationStepStatus; note: string | null } {
    if (definition.documentType) {
      const document = state.latestDocument.get(definition.documentType);
      if (!document) return { status: DriverApplicationStepStatus.NOT_SUBMITTED, note: null };
      return { status: this.fromReview(document.status), note: document.reviewNote };
    }

    switch (definition.key) {
      case DriverApplicationStep.PROFILE_PICTURE:
        // Nobody reviews an avatar, so having one is the whole of it.
        return state.avatarFileId
          ? { status: DriverApplicationStepStatus.APPROVED, note: null }
          : { status: DriverApplicationStepStatus.NOT_SUBMITTED, note: null };

      case DriverApplicationStep.VEHICLE:
        // The photo is part of the vehicle, so a vehicle without one is not
        // yet submitted — the driver has more to do, not something to await.
        if (!state.vehicle || !state.vehicle.photoFileId) {
          return { status: DriverApplicationStepStatus.NOT_SUBMITTED, note: null };
        }
        return { status: this.fromReview(state.vehicle.status), note: state.vehicle.reviewNote };

      case DriverApplicationStep.BANKING:
        return state.bankComplete
          ? { status: DriverApplicationStepStatus.APPROVED, note: null }
          : { status: DriverApplicationStepStatus.NOT_SUBMITTED, note: null };

      default:
        return { status: DriverApplicationStepStatus.NOT_SUBMITTED, note: null };
    }
  }

  /**
   * An expired document is treated as never submitted: the driver has to send
   * a new one, which is the same action the screen offers for a blank row.
   */
  private fromReview(status: DocumentReviewStatus): DriverApplicationStepStatus {
    switch (status) {
      case DocumentReviewStatus.APPROVED:
        return DriverApplicationStepStatus.APPROVED;
      case DocumentReviewStatus.REJECTED:
        return DriverApplicationStepStatus.REJECTED;
      case DocumentReviewStatus.PENDING:
        return DriverApplicationStepStatus.PENDING;
      default:
        return DriverApplicationStepStatus.NOT_SUBMITTED;
    }
  }
}
