// Import Library
import express from "express";
// Import Middleware
import authMiddleware from "../middlewares/auth.middleware";
import roleMiddleware from "../middlewares/role.middleware";
import sessionMiddleware from "../middlewares/session.middleware";
import { matchesImageSignature, uploadAdminImage } from "../middlewares/upload.middleware";
// Import Services
import * as authService from "../services/auth.service";
// Import Config
import { uploadAdminProfileImage } from "../config/spaces";
// Import Utils
import ApiError from "../utils/api-error";
// Import Types
import type { Request } from "express";
import type { SecurityAuditRequestContext } from "../types/shared/security-audit-log.type";

const router = express.Router();

/* -------------------------------------- Functions -------------------------------------- */

function buildSecurityAuditContext(req: Request): SecurityAuditRequestContext {
  return {
    ip_address: req.ip ?? null,
    user_agent: req.header("user-agent") ?? null,
    request_id: req.requestId ?? null,
  };
}

/* -------------------------------------- Authentication Routes -------------------------------------- */

router.post(
  "/login",
  async (req, res, next) => {
    try {
      const result = await authService.login(req.body, buildSecurityAuditContext(req));
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/login/confirm-force",
  async (req, res, next) => {
    try {
      const result = await authService.confirmForceLogin(
        req.body,
        buildSecurityAuditContext(req)
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/refresh",
  async (req, res, next) => {
    try {
      const result = await authService.refresh(req.body);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/logout",
  authMiddleware,
  sessionMiddleware,
  async (req, res, next) => {
    try {
      const result = await authService.logout(req.auth, buildSecurityAuditContext(req));
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/push-token",
  authMiddleware,
  sessionMiddleware,
  roleMiddleware(["worker"]),
  async (req, res, next) => {
    try {
      const result = await authService.registerWorkerPushToken(
        req.auth,
        req.session,
        req.body
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/me",
  authMiddleware,
  sessionMiddleware,
  async (req, res, next) => {
    try {
      const result = await authService.me(req.auth, req.session);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  "/me/password",
  authMiddleware,
  sessionMiddleware,
  roleMiddleware(["admin"]),
  async (req, res, next) => {
    try {
      const result = await authService.changeOwnPassword(
        req.auth,
        req.body,
        buildSecurityAuditContext(req)
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  "/me/lang",
  authMiddleware,
  sessionMiddleware,
  async (req, res, next) => {
    try {
      const result = await authService.updateOwnLang(req.auth, req.body);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  "/me",
  authMiddleware,
  sessionMiddleware,
  roleMiddleware(["admin"]),
  async (req, res, next) => {
    try {
      const result = await authService.updateOwnProfile(
        req.auth,
        req.session,
        req.body,
        buildSecurityAuditContext(req)
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/me/upload-image",
  authMiddleware,
  sessionMiddleware,
  roleMiddleware(["admin"]),
  uploadAdminImage.single("file"),
  async (req, res, next) => {
    try {
      if (!req.file) {
        throw new ApiError(400, "IMAGE_FILE_REQUIRED", "Image file is required.");
      }

      // ตรวจสอบว่า file ที่ upload ตรงกับ signature ของ image type ที่อนุญาตหรือไม่
      if (!matchesImageSignature(req.file.buffer, req.file.mimetype)) {
        throw new ApiError(
          400,
          "INVALID_IMAGE_TYPE",
          "Uploaded file content does not match an allowed image type."
        );
      }

      const imageUrl = await uploadAdminProfileImage(req.file.buffer, req.file.mimetype);
      const result = await authService.uploadOwnProfileImage(
        req.auth,
        imageUrl,
        buildSecurityAuditContext(req)
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
