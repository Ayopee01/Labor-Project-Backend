INSERT INTO "system_settings" ("key", "value", "updated_by", "updated_at")
VALUES
  ('worker_accept_timeout_limit', '3', NULL, CURRENT_TIMESTAMP),
  ('vendor_confirm_timeout_hours', '24', NULL, CURRENT_TIMESTAMP),
  ('vendor_reconfirm_timeout_hours', '4', NULL, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

UPDATE "system_settings"
SET "value" = '4'
WHERE "key" = 'worker_break_limit'
  AND "value" = '5';
