import { DriverDocumentType } from '../../generated/prisma/enums.js';

/**
 * Documents a driver must have approved before they may go online.
 *
 * Kept here rather than inside the availability check so the driver app can
 * show the same checklist the server enforces, and so a policy change is one
 * edit rather than a hunt through services.
 *
 * Only the national ID is asked for here. The vehicle's own papers are not a
 * driver document any more: a vehicle is a record in its own right, carrying
 * its photo and its own review, so requiring `VEHICLE_REGISTRATION` as well
 * asked for the same thing twice and gave an operator two places to approve.
 *
 * `NATIONAL_ID_FRONT`, `DRIVER_LICENSE_FRONT` and `VEHICLE_REGISTRATION` stay
 * in `DriverDocumentType` rather than being deleted: drivers approved under
 * the old policy have them on file, and an operator must be able to open what
 * they were approved against. They are simply never required again.
 */
export const REQUIRED_DRIVER_DOCUMENTS = [DriverDocumentType.NATIONAL_ID_BACK] as const;

export const DOCUMENT_LABELS: Record<DriverDocumentType, string> = {
  [DriverDocumentType.NATIONAL_ID_FRONT]: 'National ID (front)',
  [DriverDocumentType.NATIONAL_ID_BACK]: 'National ID (back)',
  [DriverDocumentType.DRIVER_LICENSE_FRONT]: 'Driving licence (front)',
  [DriverDocumentType.DRIVER_LICENSE_BACK]: 'Driving licence (back)',
  [DriverDocumentType.VEHICLE_REGISTRATION]: 'Vehicle registration',
  [DriverDocumentType.CERTIFICATE_OF_REGISTRY]: 'Certificate of registry',
  [DriverDocumentType.VEHICLE_PHOTO]: 'Vehicle photo',
  [DriverDocumentType.INSURANCE]: 'Insurance',
  [DriverDocumentType.OTHER]: 'Other document',
};
