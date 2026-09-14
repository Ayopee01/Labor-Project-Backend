ALTER TABLE "accounts"
ALTER COLUMN "lang" SET DEFAULT 'TH';

UPDATE "accounts"
SET "lang" = CASE UPPER("lang")
    WHEN 'TH' THEN 'TH'
    WHEN 'EN' THEN 'EN'
    WHEN 'MY' THEN 'MN'
    WHEN 'MN' THEN 'MN'
    WHEN 'KM' THEN 'CN'
    WHEN 'CN' THEN 'CN'
    ELSE 'TH'
END;

ALTER TABLE "worker_notifications"
ADD COLUMN "notification_key" VARCHAR(100),
ADD COLUMN "lang" VARCHAR(10) NOT NULL DEFAULT 'TH';

UPDATE "worker_notifications"
SET "lang" = 'TH'
WHERE "lang" IS NULL OR "lang" = '';

CREATE INDEX "worker_notifications_notification_key_created_at_idx"
ON "worker_notifications"("notification_key", "created_at");
