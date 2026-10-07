// Import Library
import express from "express";
// Import Services
import { checkReadiness } from "../services/health.service";

const router = express.Router();

/* -------------------------------------- System Routes -------------------------------------- */

// Function ตอบสถานะว่า process ยังทำงานอยู่ (liveness) โดยไม่แตะ DB/Redis — เหมาะให้ตัว health check ของ platform ใช้
function handleLiveness(_req: express.Request, res: express.Response) {
  res.status(200).json({
    status: "alive",
    timestamp: new Date().toISOString(),
  });
}

// Function ตอบสถานะความพร้อมของระบบ (ready = 200 / not_ready = 503)
async function handleReadiness(_req: express.Request, res: express.Response) {
  const readiness = await checkReadiness();

  res.status(readiness.status === "ready" ? 200 : 503).json({
    ...readiness,
    timestamp: new Date().toISOString(),
  });
}

router.get("/", handleReadiness);
router.get("/ready", handleReadiness);
router.get("/livez", handleLiveness);
router.get("/live", handleLiveness);

export default router;
