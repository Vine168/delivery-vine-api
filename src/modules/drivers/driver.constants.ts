import { DriverDocumentType } from '../../generated/prisma/enums.js';

/**
 * Documents a driver must have approved before they may go online.
 *
 * Kept here rather than inside the availability check so the driver app can
 * show the same checklist the server enforces, and so a policy change is one
 * edit rather than a hunt through services.
 */
export const REQUIRED_DRIVER_DOCUMENTS = [
  DriverDocumentType.NATIONAL_ID_FRONT,
  DriverDocumentType.NATIONAL_ID_BACK,
  DriverDocumentType.DRIVER_LICENSE_FRONT,
  DriverDocumentType.VEHICLE_REGISTRATION,
] as const;

export const DOCUMENT_LABELS: Record<DriverDocumentType, string> = {
  [DriverDocumentType.NATIONAL_ID_FRONT]: 'National ID (front)',
  [DriverDocumentType.NATIONAL_ID_BACK]: 'National ID (back)',
  [DriverDocumentType.DRIVER_LICENSE_FRONT]: 'Driving licence (front)',
  [DriverDocumentType.DRIVER_LICENSE_BACK]: 'Driving licence (back)',
  [DriverDocumentType.VEHICLE_REGISTRATION]: 'Vehicle registration',
  [DriverDocumentType.VEHICLE_PHOTO]: 'Vehicle photo',
  [DriverDocumentType.INSURANCE]: 'Insurance',
  [DriverDocumentType.OTHER]: 'Other document',
};
