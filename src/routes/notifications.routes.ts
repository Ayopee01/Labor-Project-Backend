// Import Library
import express from "express";
// Import Middleware
import authMiddleware from "../middlewares/auth.middleware";
import permissionMiddleware from "../middlewares/permission.middleware";
import roleMiddleware from "../middlewares/role.middleware";
import sessionMiddleware from "../middlewares/session.middleware";
// Import Services
import * as notificationsService from "../services/notifications.service";

const router = express.Router();

/* -------------------------------------- Notifications Routes -------------------------------------- */

router.get(
  "/",
  authMiddleware,
  sessionMiddleware,
  roleMiddleware(["admin"]),
  permissionMiddleware(["jobs:read"]),
  (req, res, next) => {
    try {
      if (!req.auth) {
        throw new Error("Authentication payload is missing.");
      }

      notificationsService.subscribeAdminEvents(res, req.auth);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
