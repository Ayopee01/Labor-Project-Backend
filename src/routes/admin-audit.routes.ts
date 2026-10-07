// Import Library
import express from "express";
// Import Middlewares
import permissionMiddleware from "../middlewares/permission.middleware";
// Import Services
import * as adminAuditService from "../services/admin-audit.service";

const router = express.Router();

/* -------------------------------------- Admin Audit Routes -------------------------------------- */

router.get(
  "/audit/workers/performance",
  permissionMiddleware(["jobs:read"]),
  async (req, res, next) => {
    try {
      const result = await adminAuditService.listWorkerPerformance(req.query);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/audit/events",
  permissionMiddleware(["jobs:read"]),
  async (req, res, next) => {
    try {
      const result = await adminAuditService.listAuditEvents(
        req.query,
        req.auth?.permissions ?? []
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
