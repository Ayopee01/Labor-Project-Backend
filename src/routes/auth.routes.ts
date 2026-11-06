// Import Middlewares
import authMiddleware from "../middlewares/auth.middleware";
import roleMiddleware from "../middlewares/role.middleware";
import sessionMiddleware from "../middlewares/session.middleware";
import { matchesImageSignature, uploadAdminImage } from "../middlewares/upload.middleware";
// Import Services
import * as authService from "../services/auth.service";
// Import Utils
import { createRouter, sendJson } from "../utils/http";
import ApiError from "../utils/api-error";
import { buildSecurityAuditContext } from "../utils/security-audit-context";

const router = createRouter();

/* -------------------------------------- Authentication Routes -------------------------------------- */

router.post(
  "/login",
  async (c) => {
    const result = await authService.login(c.get("body"), buildSecurityAuditContext(c));
    return sendJson(c, result);
  }
);

router.post(
  "/login/confirm-force",
  async (c) => {
    const result = await authService.confirmForceLogin(
      c.get("body"),
      buildSecurityAuditContext(c)
    );
    return sendJson(c, result);
  }
);

router.post(
  "/refresh",
  async (c) => {
    const result = await authService.refresh(c.get("body"));
    return sendJson(c, result);
  }
);

router.post(
  "/logout",
  authMiddleware,
  sessionMiddleware,
  async (c) => {
    const result = await authService.logout(c.get("auth"), buildSecurityAuditContext(c));
    return sendJson(c, result);
  }
);

router.post(
  "/push-token",
  authMiddleware,
  sessionMiddleware,
  roleMiddleware(["worker"]),
  async (c) => {
    const result = await authService.registerWorkerPushToken(
      c.get("auth"),
      c.get("session"),
      c.get("body")
    );
    return sendJson(c, result);
  }
);

router.get(
  "/me",
  authMiddleware,
  sessionMiddleware,
  async (c) => {
    const result = await authService.me(c.get("auth"), c.get("session"));
    return sendJson(c, result);
  }
);

router.patch(
  "/me/password",
  authMiddleware,
  sessionMiddleware,
  roleMiddleware(["admin"]),
  async (c) => {
    const result = await authService.changeOwnPassword(
      c.get("auth"),
      c.get("body"),
      buildSecurityAuditContext(c)
    );
    return sendJson(c, result);
  }
);

router.patch(
  "/me/lang",
  authMiddleware,
  sessionMiddleware,
  async (c) => {
    const result = await authService.updateOwnLang(c.get("auth"), c.get("body"));
    return sendJson(c, result);
  }
);

router.patch(
  "/me",
  authMiddleware,
  sessionMiddleware,
  roleMiddleware(["admin"]),
  async (c) => {
    const result = await authService.updateOwnProfile(
      c.get("auth"),
      c.get("session"),
      c.get("body"),
      buildSecurityAuditContext(c)
    );
    return sendJson(c, result);
  }
);

router.post(
  "/me/upload-image",
  authMiddleware,
  sessionMiddleware,
  roleMiddleware(["admin"]),
  uploadAdminImage,
  async (c) => {
    const file = c.get("file");

    if (!file) {
      throw new ApiError(400, "IMAGE_FILE_REQUIRED", "Image file is required.");
    }

    // ตรวจสอบว่า file ที่ upload ตรงกับ signature ของ image type ที่อนุญาตหรือไม่
    if (!matchesImageSignature(file.buffer, file.mimetype)) {
      throw new ApiError(
        400,
        "INVALID_IMAGE_TYPE",
        "Uploaded file content does not match an allowed image type."
      );
    }

    const result = await authService.uploadOwnProfileImage(
      c.get("auth"),
      { buffer: file.buffer, mime_type: file.mimetype },
      buildSecurityAuditContext(c)
    );
    return sendJson(c, result);
  }
);

export default router;
