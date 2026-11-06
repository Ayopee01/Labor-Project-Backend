// Import Services
import { checkReadiness } from "../services/health.service";
// Import Types
import type { AppContext } from "../types/shared/http.type";
// Import Utils
import { createRouter, sendJson } from "../utils/http";

const router = createRouter();

/* -------------------------------------- System Routes -------------------------------------- */

// Function ตอบสถานะว่า process ยังทำงานอยู่ (liveness) โดยไม่แตะ DB/Redis — เหมาะให้ตัว health check ของ platform ใช้
function handleLiveness(c: AppContext): Response {
  return sendJson(c, { status: "alive", timestamp: new Date().toISOString() });
}

// Function ตอบสถานะความพร้อมของระบบ (ready = 200 / not_ready = 503)
async function handleReadiness(c: AppContext): Promise<Response> {
  const readiness = await checkReadiness();

  return sendJson(c, { ...readiness, timestamp: new Date().toISOString() }, readiness.status === "ready" ? 200 : 503);
}

router.get("/", handleReadiness);
router.get("/ready", handleReadiness);
router.get("/livez", handleLiveness);
router.get("/live", handleLiveness);

export default router;
