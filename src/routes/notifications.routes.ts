// Import Library
import express from "express";
// Import Middlewares
import permissionMiddleware from "../middlewares/permission.middleware";
// Import Services
import * as notificationsService from "../services/notifications.service";

const router = express.Router();

/* -------------------------------------- Notifications Routes -------------------------------------- */

router.get(
  "/",
  permissionMiddleware(["jobs:read"]),
  async (req, res, next) => {
    try {
      if (!req.auth) {
        throw new Error("Authentication payload is missing.");
      }

      await notificationsService.subscribeAdminEvents(res, req.auth, req.get("Last-Event-ID")?.trim() || undefined);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
