// Import Library
import express from "express";
// Import Middleware
import driverSessionMiddleware from "../middlewares/driver-session.middleware";
import { driverQrRateLimitMiddleware } from "../middlewares/driver-qr-rate-limit.middleware";
// Import Services
import * as driverService from "../services/driver.service";
// Import Utils
import ApiError from "../utils/api-error";

const router = express.Router();

/* -------------------------------------- Driver Routes -------------------------------------- */

router.post(
  "/qr-sessions",
  driverQrRateLimitMiddleware,
  async (req, res, next) => {
    try {
      const result = await driverService.createDriverSessionFromQr(req.body);
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/jobs/current",
  driverSessionMiddleware,
  async (req, res, next) => {
    try {
      const result = await driverService.getDriverCurrentJob(req.driverSession);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/jobs/:ticketNumber/ready",
  driverSessionMiddleware,
  async (req, res, next) => {
    try {
      const result = await driverService.markDriverJobReady(
        req.params.ticketNumber,
        req.driverSession
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

// Realtime channel ของ Driver Web — SSE แทน WebSocket (ดูเหตุผลใน docs/backend-missing-apis-spec V9.md
// ข้อ 38.7: ทั้งคู่เป็น push-only, mutation ยังไปทาง REST เสมอ, และโปรเจกต์นี้มี SSE infra สำหรับ Admin
// อยู่แล้วที่ทำ auth ผ่าน header ปกติได้โดยไม่ต้องทำ message-based handshake เหมือนสเปค WS เดิม)
router.get(
  "/jobs/stream",
  driverSessionMiddleware,
  (req, res, next) => {
    try {
      if (!req.driverSession) {
        throw new ApiError(401, "MISSING_DRIVER_SESSION", "Missing driver session.");
      }

      driverService.subscribeDriverJobStream(res, req.driverSession);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
