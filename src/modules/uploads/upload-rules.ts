import { FilePurpose, FileVisibility } from '../../generated/prisma/enums.js';

export interface UploadRule {
  visibility: FileVisibility;
  mimeTypes: readonly string[];
  maxBytes: number;
  /**
   * What the account must be able to do to create a file for this purpose.
   * `mobile` means either capability — anyone with a mobile account.
   */
  requires: 'customer' | 'driver' | 'mobile';
}

const IMAGES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const;
const DOCUMENTS = [...IMAGES, 'application/pdf'] as const;

const MB = 1024 * 1024;

/** Every driver document follows the same rules, whichever purpose it is uploaded under. */
const DRIVER_DOCUMENT_RULE: UploadRule = {
  visibility: FileVisibility.PRIVATE,
  mimeTypes: DOCUMENTS,
  maxBytes: 10 * MB,
  requires: 'driver',
};

/**
 * The files the driver application points at are uploaded before it is sent,
 * and sending it is what makes the account a driver — so any mobile account
 * may upload them. Nothing is attached to anything until the application is.
 */
const APPLICATION_DOCUMENT_RULE: UploadRule = { ...DRIVER_DOCUMENT_RULE, requires: 'mobile' };

/**
 * What may be uploaded, by whom, how large, and whether the result is world
 * readable. Driving this from data rather than per-endpoint checks means a new
 * upload endpoint cannot forget a rule.
 *
 * National IDs, licences, proof-of-delivery photos and KHQR images are PRIVATE:
 * they are only ever served through a short-lived presigned URL.
 */
export const UPLOAD_RULES: Record<FilePurpose, UploadRule> = {
  [FilePurpose.CUSTOMER_AVATAR]: {
    visibility: FileVisibility.PUBLIC,
    mimeTypes: IMAGES,
    maxBytes: 5 * MB,
    requires: 'customer',
  },
  // Part of the driver application, so uploaded before it makes the account a
  // driver — see APPLICATION_DOCUMENT_RULE.
  [FilePurpose.DRIVER_AVATAR]: {
    visibility: FileVisibility.PUBLIC,
    mimeTypes: IMAGES,
    maxBytes: 5 * MB,
    requires: 'mobile',
  },
  [FilePurpose.VEHICLE_PHOTO]: {
    visibility: FileVisibility.PUBLIC,
    mimeTypes: IMAGES,
    maxBytes: 8 * MB,
    requires: 'mobile',
  },
  [FilePurpose.DRIVER_DOCUMENT]: DRIVER_DOCUMENT_RULE,
  // The three documents the application names each have their own purpose, so
  // a file uploaded as one cannot be filed as another.
  [FilePurpose.NATIONAL_ID]: APPLICATION_DOCUMENT_RULE,
  [FilePurpose.DRIVING_LICENSE]: APPLICATION_DOCUMENT_RULE,
  [FilePurpose.CERTIFICATE_OF_REGISTRY]: APPLICATION_DOCUMENT_RULE,
  // The application's banking part may carry one.
  [FilePurpose.KHQR_IMAGE]: {
    visibility: FileVisibility.PRIVATE,
    mimeTypes: IMAGES,
    maxBytes: 5 * MB,
    requires: 'mobile',
  },
  [FilePurpose.PROOF_OF_DELIVERY]: {
    visibility: FileVisibility.PRIVATE,
    mimeTypes: IMAGES,
    maxBytes: 8 * MB,
    requires: 'driver',
  },
  [FilePurpose.PACKAGE_PHOTO]: {
    visibility: FileVisibility.PRIVATE,
    mimeTypes: IMAGES,
    maxBytes: 8 * MB,
    requires: 'customer',
  },
  [FilePurpose.CHAT_ATTACHMENT]: {
    visibility: FileVisibility.PRIVATE,
    mimeTypes: IMAGES,
    maxBytes: 8 * MB,
    requires: 'mobile',
  },
};

/** The largest upload any purpose permits — used for the multipart limit. */
export const MAX_UPLOAD_BYTES = Math.max(...Object.values(UPLOAD_RULES).map((rule) => rule.maxBytes));
