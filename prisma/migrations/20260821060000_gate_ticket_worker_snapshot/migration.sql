-- Per-booth worker roster snapshot, captured once when a booth (GateTicket) is confirmed
-- (vendor confirm or auto-confirm timeout). Used as the divisor + worker list for that booth's
-- own products at financialize time, instead of the Business Ticket-wide roster taken once at
-- the very end — so a worker cancelled after this booth already confirmed does not unfairly
-- shrink this booth's payout, and every worker who was active when this specific booth confirmed
-- stays counted for it regardless of what happens to their Ticket-wide roster status afterward.
CREATE TABLE "gate_ticket_worker_snapshots" (
    "id" SERIAL NOT NULL,
    "gate_ticket_id" INTEGER NOT NULL,
    "ticket_worker_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gate_ticket_worker_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gate_ticket_worker_snapshots_gate_ticket_id_ticket_worker__key" ON "gate_ticket_worker_snapshots"("gate_ticket_id", "ticket_worker_id");

-- CreateIndex
CREATE INDEX "gate_ticket_worker_snapshots_ticket_worker_id_idx" ON "gate_ticket_worker_snapshots"("ticket_worker_id");

-- AddForeignKey
ALTER TABLE "gate_ticket_worker_snapshots" ADD CONSTRAINT "gate_ticket_worker_snapshots_gate_ticket_id_fkey" FOREIGN KEY ("gate_ticket_id") REFERENCES "gate_tickets"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "gate_ticket_worker_snapshots" ADD CONSTRAINT "gate_ticket_worker_snapshots_ticket_worker_id_fkey" FOREIGN KEY ("ticket_worker_id") REFERENCES "ticket_workers"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
