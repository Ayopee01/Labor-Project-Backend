INSERT INTO "system_settings" ("key", "value", "updated_by", "updated_at")
VALUES
  ('worker_scan_warning_before_minutes', '2', NULL, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
