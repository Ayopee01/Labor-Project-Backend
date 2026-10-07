CREATE TABLE "worker_shift_attendances" (
  "id" SERIAL NOT NULL,
  "account_id" INTEGER NOT NULL,
  "worker_code" VARCHAR(100) NOT NULL,
  "shift_instance_key" VARCHAR(100) NOT NULL,
  "shift_no" INTEGER NOT NULL,
  "shift_start_time" CHAR(5) NOT NULL,
  "shift_end_time" CHAR(5) NOT NULL,
  "first_online_at" TIMESTAMP(3),
  "last_online_at" TIMESTAMP(3),
  "offline_at" TIMESTAMP(3),
  "closed_at" TIMESTAMP(3),
  "close_reason" VARCHAR(100),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "worker_shift_attendances_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "worker_shift_attendances"
ADD CONSTRAINT "worker_shift_attendances_account_id_fkey"
FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
ON DELETE CASCADE ON UPDATE NO ACTION;

CREATE UNIQUE INDEX "worker_shift_attendances_account_id_shift_instance_key_key"
ON "worker_shift_attendances" ("account_id", "shift_instance_key");

CREATE INDEX "worker_shift_attendances_worker_code_shift_instance_key_idx"
ON "worker_shift_attendances" ("worker_code", "shift_instance_key");

CREATE INDEX "worker_shift_attendances_closed_at_idx"
ON "worker_shift_attendances" ("closed_at");
