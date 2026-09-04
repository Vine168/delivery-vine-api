-- AlterTable
ALTER TABLE "DriverEarning" ADD COLUMN     "cashCollectedAmount" INTEGER NOT NULL DEFAULT 0;

-- A driver paid in cash is holding the platform's commission, so their account
-- with the platform is legitimately overdrawn until they remit it. The balance
-- may therefore go negative; what must not happen is an overdrawn wallet
-- funding a withdrawal, which the reservation rule below still prevents.
ALTER TABLE "Wallet" DROP CONSTRAINT "Wallet_balance_non_negative";
ALTER TABLE "Wallet" DROP CONSTRAINT "Wallet_reserved_within_balance";

-- You still cannot reserve money you do not have: against a negative balance
-- the ceiling is zero, so nothing can be promised out of an overdraft.
ALTER TABLE "Wallet"
  ADD CONSTRAINT "Wallet_reserved_within_positive_balance"
  CHECK ("reservedBalance" <= GREATEST("balance", 0));

-- Ledger rows record the balance either side of the movement, and that balance
-- can now be negative.
ALTER TABLE "WalletTransaction" DROP CONSTRAINT "WalletTransaction_balance_non_negative";
