-- master_owner_stalls: แผงเดียวมีได้หลาย LINE ของเจ้าของ (unique ตาม marketCode + boothCode + lineUserId)
DROP INDEX "master_owner_stalls_market_code_booth_code_key";
DROP INDEX "master_owner_stalls_owner_status_idx";
ALTER TABLE "master_owner_stalls" DROP COLUMN "customer_telephone",
DROP COLUMN "owner_status",
DROP COLUMN "synced_at";
CREATE UNIQUE INDEX "master_owner_stalls_market_code_booth_code_line_user_id_key" ON "master_owner_stalls"("market_code", "booth_code", "line_user_id");
CREATE INDEX "master_owner_stalls_market_code_booth_code_idx" ON "master_owner_stalls"("market_code", "booth_code");

-- master_member_stalls: ลูกแผงผูกกับเจ้าของตาม marketCode + ownerIdCard (unique ตาม marketCode + ownerIdCard + memberStallLineUserId)
DROP INDEX "master_member_stalls_market_code_owner_id_card_owner_line_u_key";
DROP INDEX "master_member_stalls_market_code_owner_id_card_owner_line_u_idx";
DROP INDEX "master_member_stalls_member_stall_status_on_stall_idx";
ALTER TABLE "master_member_stalls" DROP COLUMN "market_name",
DROP COLUMN "member_stall_id_card",
DROP COLUMN "member_stall_status_on_stall",
DROP COLUMN "member_stall_telephone",
DROP COLUMN "member_stall_user_group",
DROP COLUMN "owner_line_user_id",
DROP COLUMN "synced_at";
CREATE UNIQUE INDEX "master_member_stalls_market_code_owner_id_card_member_stall_key" ON "master_member_stalls"("market_code", "owner_id_card", "member_stall_line_user_id");
