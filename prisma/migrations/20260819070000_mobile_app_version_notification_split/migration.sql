-- Split the single "when to notify" timestamp into two independent triggers: releaseNotificationAt
-- (when the FCM release notice fires) vs forceUpdateAt (when the version actually becomes
-- effective/required, already existed, unchanged). Sending the notification never activates the
-- version. Existing rows had a single immediate/scheduled behavior implied by notification_at
-- being set or not, so backfill release_notification_mode from that same signal.
ALTER TABLE "mobile_app_versions" RENAME COLUMN "notification_at" TO "release_notification_at";

ALTER TABLE "mobile_app_versions" ADD COLUMN "release_at" TIMESTAMP(3);
ALTER TABLE "mobile_app_versions" ADD COLUMN "release_notification_mode" VARCHAR(20) NOT NULL DEFAULT 'immediate';

UPDATE "mobile_app_versions"
SET "release_notification_mode" = 'scheduled'
WHERE "release_notification_at" IS NOT NULL AND "notification_sent_at" IS NULL;

ALTER TABLE "mobile_app_versions" DROP COLUMN "release_title";

DROP INDEX "mobile_app_versions_notification_at_notification_sent_at_idx";
CREATE INDEX "mobile_app_versions_release_notification_idx" ON "mobile_app_versions"("release_notification_at", "notification_sent_at");
