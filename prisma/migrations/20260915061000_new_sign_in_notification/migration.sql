-- Told to the account holder when a device they have not used before signs
-- in: one password now opens a driver's wallet as well as the customer app.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'NEW_SIGN_IN';
