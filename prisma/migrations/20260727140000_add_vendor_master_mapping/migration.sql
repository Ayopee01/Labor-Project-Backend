CREATE TABLE "vendor_owners" (
    "id" SERIAL NOT NULL,
    "citizen_id_hash" VARCHAR(128) NOT NULL,
    "citizen_id_last4" CHAR(4) NOT NULL,
    "owner_name" VARCHAR(255) NOT NULL,
    "vendor_line_id" VARCHAR(255),
    "phone" VARCHAR(50),
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_owners_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "vendor_booths" (
    "id" SERIAL NOT NULL,
    "owner_id" INTEGER NOT NULL,
    "booth_code" VARCHAR(100) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_booths_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vendor_owners_citizen_id_hash_key" ON "vendor_owners"("citizen_id_hash");
CREATE INDEX "vendor_owners_status_idx" ON "vendor_owners"("status");

CREATE UNIQUE INDEX "vendor_booths_booth_code_key" ON "vendor_booths"("booth_code");
CREATE INDEX "vendor_booths_owner_id_status_idx" ON "vendor_booths"("owner_id", "status");
CREATE INDEX "vendor_booths_status_idx" ON "vendor_booths"("status");

ALTER TABLE "vendor_booths" ADD CONSTRAINT "vendor_booths_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "vendor_owners"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
