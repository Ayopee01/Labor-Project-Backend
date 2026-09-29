-- CreateTable
CREATE TABLE "system_settings" (
    "key" VARCHAR(100) NOT NULL,
    "value" VARCHAR(255) NOT NULL,
    "updated_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "account_permissions" (
    "id" SERIAL NOT NULL,
    "account_id" INTEGER NOT NULL,
    "permission" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "account_permissions_account_id_permission_key" ON "account_permissions"("account_id", "permission");

-- CreateIndex
CREATE INDEX "account_permissions_permission_idx" ON "account_permissions"("permission");

-- AddForeignKey
ALTER TABLE "account_permissions" ADD CONSTRAINT "account_permissions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
