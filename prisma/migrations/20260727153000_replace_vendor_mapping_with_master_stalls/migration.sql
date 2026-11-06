CREATE TABLE "master_owner_stalls" (
  "id" SERIAL NOT NULL,
  "market_code" VARCHAR(50) NOT NULL,
  "booth_code" VARCHAR(100) NOT NULL,
  "booth_name" VARCHAR(255),
  "card_id" VARCHAR(50) NOT NULL,
  "customer_telephone" VARCHAR(50),
  "first_name" VARCHAR(255),
  "last_name" VARCHAR(255),
  "owner_status" VARCHAR(50),
  "line_user_id" VARCHAR(255),
  "status" VARCHAR(20) NOT NULL DEFAULT 'active',
  "synced_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "master_owner_stalls_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "master_member_stalls" (
  "id" SERIAL NOT NULL,
  "owner_line_user_id" VARCHAR(255) NOT NULL,
  "owner_id_card" VARCHAR(50) NOT NULL,
  "owner_telephone" VARCHAR(50),
  "owner_code" VARCHAR(50),
  "owner_name" VARCHAR(255),
  "market_code" VARCHAR(50) NOT NULL,
  "market_name" VARCHAR(255),
  "member_stall_line_user_id" VARCHAR(255) NOT NULL,
  "member_stall_id_card" VARCHAR(50),
  "member_stall_telephone" VARCHAR(50),
  "member_stall_user_group" VARCHAR(50),
  "member_stall_first_name" VARCHAR(255),
  "member_stall_last_name" VARCHAR(255),
  "member_stall_status_on_stall" VARCHAR(20),
  "status" VARCHAR(20) NOT NULL DEFAULT 'active',
  "synced_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "master_member_stalls_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "master_owner_stalls_market_code_booth_code_key"
  ON "master_owner_stalls"("market_code", "booth_code");
CREATE INDEX "master_owner_stalls_market_code_card_id_line_user_id_idx"
  ON "master_owner_stalls"("market_code", "card_id", "line_user_id");
CREATE INDEX "master_owner_stalls_line_user_id_idx"
  ON "master_owner_stalls"("line_user_id");
CREATE INDEX "master_owner_stalls_status_idx"
  ON "master_owner_stalls"("status");
CREATE INDEX "master_owner_stalls_owner_status_idx"
  ON "master_owner_stalls"("owner_status");

CREATE UNIQUE INDEX "master_member_stalls_market_code_owner_id_card_owner_line_use_key"
  ON "master_member_stalls"("market_code", "owner_id_card", "owner_line_user_id", "member_stall_line_user_id");
CREATE INDEX "master_member_stalls_market_code_owner_id_card_owner_line_user_id_idx"
  ON "master_member_stalls"("market_code", "owner_id_card", "owner_line_user_id");
CREATE INDEX "master_member_stalls_member_stall_line_user_id_idx"
  ON "master_member_stalls"("member_stall_line_user_id");
CREATE INDEX "master_member_stalls_status_idx"
  ON "master_member_stalls"("status");
CREATE INDEX "master_member_stalls_member_stall_status_on_stall_idx"
  ON "master_member_stalls"("member_stall_status_on_stall");

DROP TABLE IF EXISTS "vendor_booths";
DROP TABLE IF EXISTS "vendor_owners";
