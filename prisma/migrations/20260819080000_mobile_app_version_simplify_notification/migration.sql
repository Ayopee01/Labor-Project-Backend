-- Simplify Mobile App Version notification config: drop the standalone force_update flag (a
-- version now forces update purely by having force_update_at set — no separate boolean that could
-- disagree with it) and the release_notification_mode enum (release_notification_at now doubles as
-- the mode: null means send immediately, a value means schedule for that time). Add a second,
-- independent "sent" tracker for the new automatic force-update-now notification that fires at
-- force_update_at, alongside the existing tracker (renamed for clarity) for the release pre-notice.
ALTER TABLE "mobile_app_versions" DROP COLUMN "force_update";
ALTER TABLE "mobile_app_versions" DROP COLUMN "release_notification_mode";

ALTER TABLE "mobile_app_versions" RENAME COLUMN "notification_sent_at" TO "release_notification_sent_at";
ALTER TABLE "mobile_app_versions" ADD COLUMN "force_update_notification_sent_at" TIMESTAMP(3);
