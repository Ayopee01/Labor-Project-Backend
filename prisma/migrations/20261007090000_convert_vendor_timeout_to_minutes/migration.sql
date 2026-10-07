-- เปลี่ยน timeout การยืนยันของ Vendor จากหน่วยชั่วโมงเป็นนาที (เพดาน 1440 นาที = 24 ชั่วโมง)
-- ไม่แตะ updated_at เพราะ deadline ของแผงที่รออยู่นับจาก updated_at ของ setting

-- UpdateData
UPDATE "system_settings"
SET "key" = 'vendor_confirm_timeout_minutes',
    "value" = LEAST(CAST("value" AS INTEGER) * 60, 1440)::text
WHERE "key" = 'vendor_confirm_timeout_hours';

-- UpdateData
UPDATE "system_settings"
SET "key" = 'vendor_reconfirm_timeout_minutes',
    "value" = LEAST(CAST("value" AS INTEGER) * 60, 1440)::text
WHERE "key" = 'vendor_reconfirm_timeout_hours';
