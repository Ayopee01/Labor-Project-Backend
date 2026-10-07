// Import Library
import express from "express";
// Import Middlewares
import { ticketReferenceLogParam } from "../middlewares/log-context.middleware";
import driverSessionMiddleware from "../middlewares/driver-session.middleware";
import { driverQrRateLimitMiddleware } from "../middlewares/driver-qr-rate-limit.middleware";
// Import Services
import * as driverService from "../services/driver.service";
// Import Utils
import ApiError from "../utils/api-error";

const router = express.Router();

// เติม TicketNumber/TicketNo จาก path ลง log context (ใช้ค้น log/Sentry)
router.param("ticketNumber", ticketReferenceLogParam("ticketNumber"));

/* -------------------------------------- Driver Routes -------------------------------------- */

router.post(
  "/qr-sessions",
  ...driverQrRateLimitMiddleware,
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

router.patch(
  "/jobs/:ticketNumber/dispatch",
  driverSessionMiddleware,
  async (req, res, next) => {
    try {
      const result = await driverService.changeDriverJobDispatch(
        req.params.ticketNumber,
        req.body,
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
  async (req, res, next) => {
    try {
      if (!req.driverSession) {
        throw new ApiError(401, "MISSING_DRIVER_SESSION", "Missing driver session.");
      }

      await driverService.subscribeDriverJobStream(res, req.driverSession);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
