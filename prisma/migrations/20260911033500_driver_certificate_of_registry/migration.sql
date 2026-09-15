-- Adds an optional "certificate of registry" document a driver may submit.
--
-- Optional on purpose: it is not in REQUIRED_DRIVER_DOCUMENTS, so it never
-- blocks going online. Placed next to VEHICLE_REGISTRATION because the two are
-- read together, and they are genuinely different papers.
ALTER TYPE "DriverDocumentType" ADD VALUE 'CERTIFICATE_OF_REGISTRY' AFTER 'VEHICLE_REGISTRATION';
