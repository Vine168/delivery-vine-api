-- Upload purposes of their own for the three documents the driver application
-- names — the national ID, the driving licence and the certificate of
-- registry — so a file uploaded as one cannot be filed as another.
-- DRIVER_DOCUMENT stays for every other document type, and for older builds.
--
-- Added in reverse, each straight after DRIVER_DOCUMENT, so they land in the
-- schema's order without leaning on a value added in this same transaction.
ALTER TYPE "FilePurpose" ADD VALUE IF NOT EXISTS 'CERTIFICATE_OF_REGISTRY' AFTER 'DRIVER_DOCUMENT';
ALTER TYPE "FilePurpose" ADD VALUE IF NOT EXISTS 'DRIVING_LICENSE' AFTER 'DRIVER_DOCUMENT';
ALTER TYPE "FilePurpose" ADD VALUE IF NOT EXISTS 'NATIONAL_ID' AFTER 'DRIVER_DOCUMENT';
