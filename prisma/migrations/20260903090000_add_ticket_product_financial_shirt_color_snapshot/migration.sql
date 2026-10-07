-- Add a nullable shirt-color snapshot on ticket_product_financials for the Monthly Stall Fee
-- Report. Existing rows stay NULL (rendered as "UNKNOWN" at read time) since this predates the
-- feature and there is no reliable historical data to backfill from.
ALTER TABLE "ticket_product_financials" ADD COLUMN     "shirt_color_snapshot" VARCHAR(20);
