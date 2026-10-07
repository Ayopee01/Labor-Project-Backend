CREATE TABLE "gate_clients" (
    "id" SERIAL NOT NULL,
    "client_id" VARCHAR(100) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "secret_hash" VARCHAR(512) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "last_used_at" TIMESTAMP(3),
    "created_by" INTEGER,
    "updated_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gate_clients_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gate_clients_client_id_key" ON "gate_clients"("client_id");
CREATE INDEX "gate_clients_status_idx" ON "gate_clients"("status");

ALTER TABLE "gate_clients" ADD CONSTRAINT "gate_clients_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "gate_clients" ADD CONSTRAINT "gate_clients_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
