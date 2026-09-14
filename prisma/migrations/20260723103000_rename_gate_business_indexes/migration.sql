ALTER INDEX IF EXISTS "vehicle_jobs_vehicle_job_ref_key"
RENAME TO "vehicle_jobs_ticket_no_key";

ALTER INDEX IF EXISTS "gate_tickets_market_job_id_stall_job_ref_key"
RENAME TO "gate_tickets_market_job_id_booth_code_key";

ALTER INDEX IF EXISTS "ticket_products_ticket_id_product_ref_key"
RENAME TO "ticket_products_ticket_id_product_code_key";
