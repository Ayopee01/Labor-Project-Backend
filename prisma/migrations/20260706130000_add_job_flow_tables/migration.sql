-- CreateTable
CREATE TABLE "gate_request_logs" (
    "id" SERIAL NOT NULL,
    "gate_transaction_ref" VARCHAR(100) NOT NULL,
    "vehicle_job_id" INTEGER,
    "payload_snapshot" JSONB NOT NULL,
    "response_snapshot" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gate_request_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_jobs" (
    "id" SERIAL NOT NULL,
    "vehicle_job_ref" VARCHAR(100) NOT NULL,
    "gate_transaction_ref" VARCHAR(100) NOT NULL,
    "license_plate" VARCHAR(50) NOT NULL,
    "workers_required" INTEGER NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'WAIT',
    "driver_qr_token" VARCHAR(255) NOT NULL,
    "worker_qr_token" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicle_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_jobs" (
    "id" SERIAL NOT NULL,
    "vehicle_job_id" INTEGER NOT NULL,
    "market_job_ref" VARCHAR(100) NOT NULL,
    "market_name" VARCHAR(255) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'WAIT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gate_tickets" (
    "id" SERIAL NOT NULL,
    "vehicle_job_id" INTEGER NOT NULL,
    "market_job_id" INTEGER NOT NULL,
    "ticket_no" VARCHAR(100) NOT NULL,
    "stall_no" VARCHAR(100),
    "vendor_name" VARCHAR(255),
    "vendor_line_id" VARCHAR(255),
    "status" VARCHAR(30) NOT NULL DEFAULT 'WAIT',
    "confirmation_status" VARCHAR(30) NOT NULL DEFAULT 'NOT_SUBMITTED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gate_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_products" (
    "id" SERIAL NOT NULL,
    "ticket_id" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL,
    "unit" VARCHAR(50) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_sessions" (
    "id" SERIAL NOT NULL,
    "vehicle_job_id" INTEGER NOT NULL,
    "session_token" VARCHAR(255) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "driver_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_queue_entries" (
    "id" SERIAL NOT NULL,
    "account_id" INTEGER NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'offline',
    "ready_at" TIMESTAMP(3),
    "break_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "worker_queue_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_job_assignments" (
    "id" SERIAL NOT NULL,
    "vehicle_job_id" INTEGER NOT NULL,
    "worker_account_id" INTEGER NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    "accept_deadline_at" TIMESTAMP(3),
    "scan_deadline_at" TIMESTAMP(3),
    "accepted_at" TIMESTAMP(3),
    "scanned_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicle_job_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gate_request_logs_gate_transaction_ref_key" ON "gate_request_logs"("gate_transaction_ref");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_jobs_vehicle_job_ref_key" ON "vehicle_jobs"("vehicle_job_ref");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_jobs_driver_qr_token_key" ON "vehicle_jobs"("driver_qr_token");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_jobs_worker_qr_token_key" ON "vehicle_jobs"("worker_qr_token");

-- CreateIndex
CREATE INDEX "vehicle_jobs_status_idx" ON "vehicle_jobs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "market_jobs_vehicle_job_id_market_job_ref_key" ON "market_jobs"("vehicle_job_id", "market_job_ref");

-- CreateIndex
CREATE INDEX "market_jobs_vehicle_job_id_status_idx" ON "market_jobs"("vehicle_job_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "gate_tickets_vehicle_job_id_ticket_no_key" ON "gate_tickets"("vehicle_job_id", "ticket_no");

-- CreateIndex
CREATE INDEX "gate_tickets_market_job_id_status_idx" ON "gate_tickets"("market_job_id", "status");

-- CreateIndex
CREATE INDEX "ticket_products_ticket_id_idx" ON "ticket_products"("ticket_id");

-- CreateIndex
CREATE UNIQUE INDEX "driver_sessions_session_token_key" ON "driver_sessions"("session_token");

-- CreateIndex
CREATE INDEX "driver_sessions_vehicle_job_id_idx" ON "driver_sessions"("vehicle_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "worker_queue_entries_account_id_key" ON "worker_queue_entries"("account_id");

-- CreateIndex
CREATE INDEX "worker_queue_entries_status_ready_at_idx" ON "worker_queue_entries"("status", "ready_at");

-- CreateIndex
CREATE INDEX "vehicle_job_assignments_worker_account_id_status_idx" ON "vehicle_job_assignments"("worker_account_id", "status");

-- CreateIndex
CREATE INDEX "vehicle_job_assignments_vehicle_job_id_status_idx" ON "vehicle_job_assignments"("vehicle_job_id", "status");

-- AddForeignKey
ALTER TABLE "gate_request_logs" ADD CONSTRAINT "gate_request_logs_vehicle_job_id_fkey" FOREIGN KEY ("vehicle_job_id") REFERENCES "vehicle_jobs"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "market_jobs" ADD CONSTRAINT "market_jobs_vehicle_job_id_fkey" FOREIGN KEY ("vehicle_job_id") REFERENCES "vehicle_jobs"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "gate_tickets" ADD CONSTRAINT "gate_tickets_vehicle_job_id_fkey" FOREIGN KEY ("vehicle_job_id") REFERENCES "vehicle_jobs"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "gate_tickets" ADD CONSTRAINT "gate_tickets_market_job_id_fkey" FOREIGN KEY ("market_job_id") REFERENCES "market_jobs"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ticket_products" ADD CONSTRAINT "ticket_products_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "gate_tickets"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "driver_sessions" ADD CONSTRAINT "driver_sessions_vehicle_job_id_fkey" FOREIGN KEY ("vehicle_job_id") REFERENCES "vehicle_jobs"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "worker_queue_entries" ADD CONSTRAINT "worker_queue_entries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "vehicle_job_assignments" ADD CONSTRAINT "vehicle_job_assignments_vehicle_job_id_fkey" FOREIGN KEY ("vehicle_job_id") REFERENCES "vehicle_jobs"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "vehicle_job_assignments" ADD CONSTRAINT "vehicle_job_assignments_worker_account_id_fkey" FOREIGN KEY ("worker_account_id") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
