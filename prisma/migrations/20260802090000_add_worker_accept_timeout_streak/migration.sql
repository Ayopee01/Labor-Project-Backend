ALTER TABLE "worker_shift_attendances"
ADD COLUMN "accept_timeout_streak" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "last_accept_timeout_at" TIMESTAMP(3);
