-- ให้สิทธิ์บันทึกงานย้อนหลัง (jobs:manual_entry) กับบัญชี Admin ทุกคนที่มีอยู่ (มีอยู่แล้วข้าม)
INSERT INTO "account_permissions" ("account_id", "permission", "created_at", "updated_at")
SELECT "id", 'jobs:manual_entry', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "accounts"
WHERE "role" = 'admin'
ON CONFLICT ("account_id", "permission") DO NOTHING;
