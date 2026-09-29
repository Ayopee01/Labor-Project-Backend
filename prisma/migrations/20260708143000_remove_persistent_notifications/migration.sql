-- Drop persistent notification inbox because realtime status is delivered via SSE.
DROP TABLE IF EXISTS "notifications";
