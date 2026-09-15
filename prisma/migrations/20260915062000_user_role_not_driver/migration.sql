-- A mobile account is one row per phone, whichever app it signs in through.
-- `role` separates mobile from back-office accounts and nothing else, so no
-- row may be a DRIVER account any more: that is the shape
-- src/database/merge-mobile-accounts.ts exists to remove.
--
-- NOT VALID so this can ship before that merge has run: rows written from now
-- on are checked, existing ones are not. Until the merge runs, an update to a
-- leftover DRIVER row is refused too, so run it straight after deploying.
ALTER TABLE "User"
  ADD CONSTRAINT "User_role_not_driver" CHECK ("role" <> 'DRIVER') NOT VALID;

-- Nothing to merge (a fresh database, or one already merged): hold it for
-- every row now. Otherwise the merge script validates it when it finishes.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "User" WHERE "role" = 'DRIVER') THEN
    ALTER TABLE "User" VALIDATE CONSTRAINT "User_role_not_driver";
  END IF;
END
$$;
