UPDATE "accounts"
SET "permission_level" = CASE
  WHEN "permission_level" = 'super_admin' THEN 'owner'
  WHEN "permission_level" = 'admin' THEN 'manager'
  ELSE "permission_level"
END
WHERE "permission_level" IN ('super_admin', 'admin');
