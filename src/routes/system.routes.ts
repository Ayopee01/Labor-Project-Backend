// Import Services
import { checkReadiness } from "../services/health.service";
// Import Types
import type { AppContext } from "../types/shared/http.type";
// Import Utils
import { createRouter, sendJson } from "../utils/http";

const router = createRouter();

/* -------------------------------------- System Routes -------------------------------------- */

// Function ตอบสถานะความพร้อมของระบบ (ready = 200 / not_ready = 503)
async function handleReadiness(c: AppContext): Promise<Response> {
  const readiness = await checkReadiness();

  return sendJson(c, { ...readiness, timestamp: new Date().toISOString() }, readiness.status === "ready" ? 200 : 503);
}

router.get("/", handleReadiness);

export default router;
