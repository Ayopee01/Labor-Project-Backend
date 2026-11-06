-- CreateTable
CREATE TABLE "ticket_workers" (
    "id" SERIAL NOT NULL,
    "ticket_id" INTEGER NOT NULL,
    "worker_account_id" INTEGER NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'IN_PROGRESS',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_workers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_completion_submissions" (
    "id" SERIAL NOT NULL,
    "ticket_id" INTEGER NOT NULL,
    "submitted_by_worker_account_id" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "note" VARCHAR(1000),
    "status" VARCHAR(30) NOT NULL DEFAULT 'WAITING_VENDOR_CONFIRM',
    "confirmed_at" TIMESTAMP(3),
    "rejected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_completion_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" SERIAL NOT NULL,
    "receiver_account_id" INTEGER NOT NULL,
    "vehicle_job_id" INTEGER,
    "ticket_id" INTEGER,
    "type" VARCHAR(100) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "message" VARCHAR(1000) NOT NULL,
    "payload" JSONB,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_delivery_logs" (
    "id" SERIAL NOT NULL,
    "channel" VARCHAR(50) NOT NULL,
    "job_name" VARCHAR(100) NOT NULL,
    "target" VARCHAR(255),
    "status" VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL,
    "last_error" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "message_delivery_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ticket_workers_ticket_id_worker_account_id_key" ON "ticket_workers"("ticket_id", "worker_account_id");

-- CreateIndex
CREATE INDEX "ticket_workers_worker_account_id_status_idx" ON "ticket_workers"("worker_account_id", "status");

-- CreateIndex
CREATE INDEX "ticket_completion_submissions_ticket_id_status_idx" ON "ticket_completion_submissions"("ticket_id", "status");

-- CreateIndex
CREATE INDEX "notifications_receiver_account_id_read_at_idx" ON "notifications"("receiver_account_id", "read_at");

-- CreateIndex
CREATE INDEX "notifications_ticket_id_idx" ON "notifications"("ticket_id");

-- CreateIndex
CREATE INDEX "message_delivery_logs_channel_status_idx" ON "message_delivery_logs"("channel", "status");

-- AddForeignKey
ALTER TABLE "ticket_workers" ADD CONSTRAINT "ticket_workers_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "gate_tickets"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ticket_workers" ADD CONSTRAINT "ticket_workers_worker_account_id_fkey" FOREIGN KEY ("worker_account_id") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ticket_completion_submissions" ADD CONSTRAINT "ticket_completion_submissions_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "gate_tickets"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ticket_completion_submissions" ADD CONSTRAINT "ticket_completion_submissions_submitted_by_worker_account_id_fkey" FOREIGN KEY ("submitted_by_worker_account_id") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_receiver_account_id_fkey" FOREIGN KEY ("receiver_account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_vehicle_job_id_fkey" FOREIGN KEY ("vehicle_job_id") REFERENCES "vehicle_jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "gate_tickets"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
