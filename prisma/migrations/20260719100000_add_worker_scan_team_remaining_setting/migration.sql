INSERT INTO "system_settings" ("key", "value", "updated_by", "updated_at")
VALUES
  ('worker_scan_team_remaining_minutes', '5', NULL, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
