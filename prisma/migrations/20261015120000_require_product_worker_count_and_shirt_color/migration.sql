-- Every ticket product, product financial and completion submission is created with its snapshot
-- value, so these columns no longer allow NULL (no legacy rows to support).
ALTER TABLE "ticket_products" ALTER COLUMN "required_worker_count_snapshot" SET NOT NULL;
ALTER TABLE "ticket_product_financials" ALTER COLUMN "shirt_color_snapshot" SET NOT NULL;
ALTER TABLE "ticket_completion_submissions" ALTER COLUMN "worker_count_snapshot" SET NOT NULL;
