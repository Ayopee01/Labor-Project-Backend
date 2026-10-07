-- Version catalog for the Worker Mobile Application. One row per released/scheduled version;
-- rows are never deleted so History always keeps every past version. current/scheduled/history
-- is derived at read time from build_number + force_update_at vs server time, not stored here.
CREATE TABLE "mobile_app_versions" (
    "id" SERIAL NOT NULL,
    "version" VARCHAR(50) NOT NULL,
    "build_number" INTEGER NOT NULL,
    "android_download_url" VARCHAR(512),
    "ios_download_url" VARCHAR(512),
    "force_update" BOOLEAN NOT NULL DEFAULT false,
    "force_update_at" TIMESTAMP(3),
    "notification_at" TIMESTAMP(3),
    "notification_sent_at" TIMESTAMP(3),
    "release_title" VARCHAR(255),
    "release_message" TEXT,
    "release_notes" TEXT,
    "created_by" INTEGER,
    "updated_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mobile_app_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mobile_app_versions_build_number_key" ON "mobile_app_versions"("build_number");

CREATE INDEX "mobile_app_versions_force_update_at_idx" ON "mobile_app_versions"("force_update_at");

CREATE INDEX "mobile_app_versions_notification_at_notification_sent_at_idx" ON "mobile_app_versions"("notification_at", "notification_sent_at");

ALTER TABLE "mobile_app_versions" ADD CONSTRAINT "mobile_app_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "mobile_app_versions" ADD CONSTRAINT "mobile_app_versions_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
