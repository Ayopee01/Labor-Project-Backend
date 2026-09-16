// Import Library
import express from "express";
// Import Middleware
import authMiddleware from "../middlewares/auth.middleware";
import permissionMiddleware from "../middlewares/permission.middleware";
import roleMiddleware from "../middlewares/role.middleware";
import sessionMiddleware from "../middlewares/session.middleware";
// Import Services
import * as adminJobsService from "../services/admin-jobs.service";
import * as adminWorkersService from "../services/admin-workers.service";

const router = express.Router();

/* -------------------------------------- Admin Jobs Routes -------------------------------------- */

router.use(authMiddleware, sessionMiddleware, roleMiddleware(["admin"]));

router.get(
  "/jobs/workers/status",
  permissionMiddleware(["jobs:read"]),
  async (req, res, next) => {
    try {
      const result = await adminWorkersService.listAdminWorkerStatuses(req.query);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/jobs/workers/:workerCode/status/force",
  permissionMiddleware(["workers:force_status"]),
  async (req, res, next) => {
    try {
      const result = await adminWorkersService.forceAdminWorkerStatus(
        req.params.workerCode,
        req.body,
        req.auth
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/vehicle-jobs/assignment/cancel",
  permissionMiddleware(["jobs:cancel"]),
  async (req, res, next) => {
    try {
      const result = await adminJobsService.cancelTicketJobAssignment(
        req.body,
        req.auth
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/vehicle-jobs/operations",
  permissionMiddleware(["jobs:read"]),
  async (req, res, next) => {
    try {
      const result = await adminJobsService.listTicketJobOperations(req.query);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/vehicle-jobs/history",
  permissionMiddleware(["jobs:read"]),
  async (req, res, next) => {
    try {
      const result = await adminJobsService.listTicketJobs(req.query);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/vehicle-jobs/history/daily-worker-income",
  permissionMiddleware(["jobs:read"]),
  async (req, res, next) => {
    try {
      const result = await adminJobsService.listDailyWorkerIncome(req.query);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/vehicle-jobs/history/daily-stall-fees",
  permissionMiddleware(["jobs:read"]),
  async (req, res, next) => {
    try {
      const result = await adminJobsService.listDailyStallFees(req.query);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/vehicle-jobs/history/monthly-stall-fees",
  permissionMiddleware(["jobs:read"]),
  async (req, res, next) => {
    try {
      const result = await adminJobsService.listMonthlyStallFees(req.query);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/vehicle-jobs/:ticketNumber/financials",
  permissionMiddleware(["jobs:read"]),
  async (req, res, next) => {
    try {
      const result = await adminJobsService.getTicketJobFinancials(
        req.params.ticketNumber
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/vehicle-jobs/:ticketNumber/assign-workers",
  permissionMiddleware(["jobs:assign"]),
  async (req, res, next) => {
    try {
      const result = await adminJobsService.assignTicketJobWorkers(
        req.params.ticketNumber,
        req.body,
        req.auth
      );
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/vehicle-jobs/:ticketNumber/scan-deadline/extend",
  permissionMiddleware(["jobs:extend_deadline"]),
  async (req, res, next) => {
    try {
      const result = await adminJobsService.extendTicketJobScanDeadline(
        req.params.ticketNumber,
        req.body,
        req.auth
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/vehicle-jobs/:ticketNumber/tickets/:ticketNo/stalls/:stallCode/override-count",
  permissionMiddleware(["jobs:override_count"]),
  async (req, res, next) => {
    try {
      const result = await adminJobsService.overrideTicketProductCounts(
        req.params.ticketNumber,
        req.params.ticketNo,
        req.params.stallCode,
        req.body,
        req.auth
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/vehicle-jobs/:ticketNumber/wait",
  permissionMiddleware(["jobs:wait"]),
  async (req, res, next) => {
    try {
      const result = await adminJobsService.changeTicketJobToWait(
        req.params.ticketNumber,
        req.body,
        req.auth
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/vehicle-jobs/:ticketNumber/release-workers",
  permissionMiddleware(["jobs:release_workers"]),
  async (req, res, next) => {
    try {
      const result = await adminJobsService.releaseTicketJobWorkers(
        req.params.ticketNumber,
        req.body,
        req.auth
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
