// Import Library
import express from "express";
// Import Middleware
import authMiddleware from "../middlewares/auth.middleware";
import roleMiddleware from "../middlewares/role.middleware";
import sessionMiddleware from "../middlewares/session.middleware";
// Import Services
import * as realtimeNotificationService from "../services/shared/realtime-notification.service";
import * as workerService from "../services/worker.service";

const router = express.Router();

/* -------------------------------------- Wroker Application Routes -------------------------------------- */

router.get(
  "/app-version/check",
  async (req, res, next) => {
    try {
      const result = await workerService.checkMobileAppVersion(req.query);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.use(authMiddleware, sessionMiddleware, roleMiddleware(["worker"]));

router.post(
  "/me/online",
  async (req, res, next) => {
    try {
      const result = await workerService.workerOnline(req.auth);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/me/offline",
  async (req, res, next) => {
    try {
      const result = await workerService.workerOffline(req.auth);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/me/break",
  async (req, res, next) => {
    try {
      const result = await workerService.workerBreak(req.auth);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/me/status",
  async (req, res, next) => {
    try {
      const result = await workerService.getWorkerStatus(req.auth);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/me/assignments/history",
  async (req, res, next) => {
    try {
      const result = await workerService.listWorkerAssignmentHistory(
        req.query,
        req.auth
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/me/earnings/summary",
  async (req, res, next) => {
    try {
      const result = await workerService.getWorkerEarningsSummary(
        req.query,
        req.auth
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/me/notifications",
  async (req, res, next) => {
    try {
      const result = await realtimeNotificationService.listWorkerNotifications(
        req.query,
        req.auth,
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/me/products/:productCode/packages",
  async (req, res, next) => {
    try {
      const result = await workerService.getWorkerProductPackageOptions(
        req.params.productCode,
        req.auth
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/me/assignments/:ticketNumber/accept",
  async (req, res, next) => {
    try {
      const result = await workerService.acceptWorkerAssignment(
        req.params.ticketNumber,
        req.auth
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/me/assignments/check-in-barcode",
  async (req, res, next) => {
    try {
      const result = await workerService.scanWorkerAssignment(
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
  "/me/assignments/tickets/complete",
  async (req, res, next) => {
    try {
      const result =
        await workerService.completeWorkerAssignmentTicketFromBody(
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
