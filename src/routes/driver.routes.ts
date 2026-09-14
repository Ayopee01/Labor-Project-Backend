// Import Library
import express from "express";
// Import Middleware
import driverSessionMiddleware from "../middlewares/driver-session.middleware";
// Import Services
import * as driverService from "../services/driver.service";

const router = express.Router();

/* -------------------------------------- Driver Routes -------------------------------------- */

router.post(
  "/qr-sessions",
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

export default router;
