// Import Library
import express from "express";
// Import Middleware
import authMiddleware from "../middlewares/auth.middleware";
import permissionMiddleware from "../middlewares/permission.middleware";
import roleMiddleware from "../middlewares/role.middleware";
import sessionMiddleware from "../middlewares/session.middleware";
// Import Services
import * as adminWorkersService from "../services/admin-workers.service";
// Import Utils
import { buildSecurityAuditContext } from "../utils/security-audit-context";

const router = express.Router();

/* -------------------------------------- Admin Workers Routes -------------------------------------- */

router.use(authMiddleware, sessionMiddleware, roleMiddleware(["admin"]));

router.post(
  "/",
  permissionMiddleware(["workers:create"]),
  async (req, res, next) => {
    try {
      const result = await adminWorkersService.createUser(
        req.body,
        req.auth,
        buildSecurityAuditContext(req)
      );
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/",
  permissionMiddleware(["workers:read"]),
  async (req, res, next) => {
    try {
      const result = await adminWorkersService.listUsers(req.query, req.auth);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/:workerCode",
  permissionMiddleware(["workers:read"]),
  async (req, res, next) => {
    try {
      const result = await adminWorkersService.getUser(String(req.params.workerCode), req.auth);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  "/:workerCode",
  permissionMiddleware(["workers:update"]),
  async (req, res, next) => {
    try {
      const result = await adminWorkersService.updateUser(
        String(req.params.workerCode),
        req.body,
        req.auth,
        buildSecurityAuditContext(req)
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  "/:workerCode/password",
  permissionMiddleware(["workers:reset_password"]),
  async (req, res, next) => {
    try {
      const result = await adminWorkersService.resetPassword(
        String(req.params.workerCode),
        req.body,
        req.auth,
        buildSecurityAuditContext(req)
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
