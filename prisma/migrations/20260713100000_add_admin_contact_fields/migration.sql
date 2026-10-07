ALTER TABLE "accounts"
ADD COLUMN "email" VARCHAR(255),
ADD COLUMN "phone" VARCHAR(50);

UPDATE "accounts"
SET
  "email" = CASE
    WHEN POSITION('@' IN "username") > 0 THEN "username"
    ELSE LOWER("username") || '@simmummuang.local'
  END,
  "phone" = '081-000-' || LPAD("id"::text, 4, '0')
WHERE "role" = 'admin';
