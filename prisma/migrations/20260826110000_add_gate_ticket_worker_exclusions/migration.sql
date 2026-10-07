-- Admin can now cancel a worker from a single booth only, leaving them WORKING on the rest of
-- the Business Ticket. TicketWorker.status stays untouched; instead this table marks the worker
-- excluded from just this one booth's payout divisor. confirmTicketCompletion checks this table
-- when it snapshots GateTicketWorkerSnapshot at confirm time, so an excluded worker is left out
-- of that booth's snapshot going forward (booths that already confirmed before the exclusion was
-- created are unaffected, matching how GateTicketWorkerSnapshot already behaves for TicketWorker
-- cancellation at the whole-ticket level).
CREATE TABLE "gate_ticket_worker_exclusions" (
    "id" SERIAL NOT NULL,
    "gate_ticket_id" INTEGER NOT NULL,
    "ticket_worker_id" INTEGER NOT NULL,
    "cancelled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gate_ticket_worker_exclusions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gate_ticket_worker_exclusions_gate_ticket_ticket_worker_key" ON "gate_ticket_worker_exclusions"("gate_ticket_id", "ticket_worker_id");

CREATE INDEX "gate_ticket_worker_exclusions_ticket_worker_id_idx" ON "gate_ticket_worker_exclusions"("ticket_worker_id");

ALTER TABLE "gate_ticket_worker_exclusions" ADD CONSTRAINT "gate_ticket_worker_exclusions_gate_ticket_id_fkey" FOREIGN KEY ("gate_ticket_id") REFERENCES "gate_tickets"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "gate_ticket_worker_exclusions" ADD CONSTRAINT "gate_ticket_worker_exclusions_ticket_worker_id_fkey" FOREIGN KEY ("ticket_worker_id") REFERENCES "ticket_workers"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
