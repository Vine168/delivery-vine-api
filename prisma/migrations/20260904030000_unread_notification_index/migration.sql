-- The unread badge is the most frequently polled query in the platform, and
-- counting through the (userId, readAt) index still had to read every unread
-- row from the heap. A partial index holds only unread rows — far smaller, and
-- it answers the count without touching the table.
CREATE INDEX "Notification_unread_idx"
  ON "Notification" ("userId")
  WHERE "readAt" IS NULL;
