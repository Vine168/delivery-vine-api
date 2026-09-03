import { FilePurpose, FileVisibility, UserRole } from '../../generated/prisma/enums.js';

export interface UploadRule {
  visibility: FileVisibility;
  mimeTypes: readonly string[];
  maxBytes: number;
  /** Roles allowed to create a file for this purpose. */
  roles: readonly UserRole[];
}

const IMAGES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const;
const DOCUMENTS = [...IMAGES, 'application/pdf'] as const;

const MB = 1024 * 1024;

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
    roles: [UserRole.CUSTOMER],
  },
  [FilePurpose.DRIVER_AVATAR]: {
    visibility: FileVisibility.PUBLIC,
    mimeTypes: IMAGES,
    maxBytes: 5 * MB,
    roles: [UserRole.DRIVER],
  },
  [FilePurpose.VEHICLE_PHOTO]: {
    visibility: FileVisibility.PUBLIC,
    mimeTypes: IMAGES,
    maxBytes: 8 * MB,
    roles: [UserRole.DRIVER],
  },
  [FilePurpose.DRIVER_DOCUMENT]: {
    visibility: FileVisibility.PRIVATE,
    mimeTypes: DOCUMENTS,
    maxBytes: 10 * MB,
    roles: [UserRole.DRIVER],
  },
  [FilePurpose.KHQR_IMAGE]: {
    visibility: FileVisibility.PRIVATE,
    mimeTypes: IMAGES,
    maxBytes: 5 * MB,
    roles: [UserRole.DRIVER],
  },
  [FilePurpose.PROOF_OF_DELIVERY]: {
    visibility: FileVisibility.PRIVATE,
    mimeTypes: IMAGES,
    maxBytes: 8 * MB,
    roles: [UserRole.DRIVER],
  },
  [FilePurpose.PACKAGE_PHOTO]: {
    visibility: FileVisibility.PRIVATE,
    mimeTypes: IMAGES,
    maxBytes: 8 * MB,
    roles: [UserRole.CUSTOMER],
  },
  [FilePurpose.CHAT_ATTACHMENT]: {
    visibility: FileVisibility.PRIVATE,
    mimeTypes: IMAGES,
    maxBytes: 8 * MB,
    roles: [UserRole.CUSTOMER, UserRole.DRIVER],
  },
};

/** The largest upload any purpose permits — used for the multipart limit. */
export const MAX_UPLOAD_BYTES = Math.max(...Object.values(UPLOAD_RULES).map((rule) => rule.maxBytes));
