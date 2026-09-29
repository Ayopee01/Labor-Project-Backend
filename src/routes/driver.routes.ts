// Import Library
import express from "express";
// Import Middlewares
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

// SSE stream ให้ Driver Web รับข้อมูลงานรถแบบ realtime
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
