-- Append-only auth/security event log (27.12 phase 1: login/logout/force-login only). Separate
-- from admin_action_logs because that table requires a non-null actor_account_id and is scoped to
-- job/ticket operational actions, while a failed login may have no resolvable actor at all (unknown
-- username). actor_account_id/actor_worker_id are plain columns with no foreign key, so a later
-- account/worker deletion can never be blocked by, or cascade into, security history.
CREATE TABLE "security_audit_logs" (
    "id" SERIAL NOT NULL,
    "event_type" VARCHAR(50) NOT NULL,
    "outcome" VARCHAR(20) NOT NULL,
    "actor_type" VARCHAR(20),
    "actor_account_id" INTEGER,
    "actor_worker_id" INTEGER,
    "actor_username" VARCHAR(100),
    "actor_full_name" VARCHAR(255),
    "session_id" INTEGER,
    "request_id" VARCHAR(100),
    "ip_address" VARCHAR(100),
    "user_agent" VARCHAR(500),
    "failure_code" VARCHAR(50),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "security_audit_logs_event_type_created_at_idx" ON "security_audit_logs"("event_type", "created_at");

-- CreateIndex
CREATE INDEX "security_audit_logs_actor_account_id_idx" ON "security_audit_logs"("actor_account_id");

-- CreateIndex
CREATE INDEX "security_audit_logs_actor_worker_id_idx" ON "security_audit_logs"("actor_worker_id");
