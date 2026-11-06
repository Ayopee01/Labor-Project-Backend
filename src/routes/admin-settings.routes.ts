// Import Middlewares
import permissionMiddleware from "../middlewares/permission.middleware";
// Import Services
import * as adminSettingsService from "../services/admin-settings.service";
// Import Utils
import { createRouter, sendJson } from "../utils/http";
import { buildSecurityAuditContext } from "../utils/security-audit-context";

const router = createRouter();

/* -------------------------------------- Admin Settings Routes -------------------------------------- */

router.get(
  "/settings",
  permissionMiddleware(["settings:read"]),
  async (c) => {
    const result = await adminSettingsService.listSystemSettings();
    return sendJson(c, result);
  }
);

router.patch(
  "/settings",
  permissionMiddleware(["settings:update"]),
  async (c) => {
    const result = await adminSettingsService.updateSystemSettings(
      c.get("body"),
      c.get("auth"),
      buildSecurityAuditContext(c)
    );
    return sendJson(c, result);
  }
);

router.get(
  "/mobile-app-versions",
  permissionMiddleware(["mobile_app_versions:read"]),
  async (c) => {
    const result = await adminSettingsService.listMobileAppVersions();
    return sendJson(c, result);
  }
);

router.post(
  "/mobile-app-versions",
  permissionMiddleware(["mobile_app_versions:create"]),
  async (c) => {
    const result = await adminSettingsService.createMobileAppVersion(
      c.get("body"),
      c.get("auth"),
      buildSecurityAuditContext(c)
    );
    return sendJson(c, result, 201);
  }
);

router.patch(
  "/mobile-app-versions/:id",
  permissionMiddleware(["mobile_app_versions:update"]),
  async (c) => {
    const result = await adminSettingsService.updateMobileAppVersion(
      c.req.param("id"),
      c.get("body"),
      c.get("auth"),
      buildSecurityAuditContext(c)
    );
    return sendJson(c, result);
  }
);

router.get(
  "/roles",
  permissionMiddleware(["roles:read"]),
  async (c) => {
    const result = await adminSettingsService.listRoles();
    return sendJson(c, result);
  }
);

router.get(
  "/gate-clients",
  permissionMiddleware(["gate_clients:read"]),
  async (c) => {
    const result = await adminSettingsService.listGateClients();
    return sendJson(c, result);
  }
);

router.post(
  "/gate-clients",
  permissionMiddleware(["gate_clients:create"]),
  async (c) => {
    const result = await adminSettingsService.createGateClient(
      c.get("body"),
      c.get("auth"),
      buildSecurityAuditContext(c)
    );
    return sendJson(c, result, 201);
  }
);

router.patch(
  "/gate-clients/:clientId",
  permissionMiddleware(["gate_clients:update"]),
  async (c) => {
    const result = await adminSettingsService.updateGateClient(
      c.req.param("clientId"),
      c.get("body"),
      c.get("auth"),
      buildSecurityAuditContext(c)
    );
    return sendJson(c, result);
  }
);

router.post(
  "/gate-clients/:clientId/secret/rotate",
  permissionMiddleware(["gate_clients:rotate_secret"]),
  async (c) => {
    const result = await adminSettingsService.rotateGateClientSecret(
      c.req.param("clientId"),
      c.get("auth"),
      buildSecurityAuditContext(c)
    );
    return sendJson(c, result);
  }
);

router.post(
  "/admins",
  permissionMiddleware(["admins:create"]),
  async (c) => {
    const result = await adminSettingsService.createAdminAccount(
      c.get("body"),
      c.get("auth"),
      buildSecurityAuditContext(c)
    );
    return sendJson(c, result, 201);
  }
);

router.patch(
  "/admins/:adminCode",
  permissionMiddleware(["admins:update"]),
  async (c) => {
    const result = await adminSettingsService.updateAdminAccount(
      c.req.param("adminCode"),
      c.get("body"),
      c.get("auth"),
      buildSecurityAuditContext(c)
    );
    return sendJson(c, result);
  }
);

router.patch(
  "/admins/:adminCode/password",
  permissionMiddleware(["admins:reset_password"]),
  async (c) => {
    const result = await adminSettingsService.resetAdminPassword(
      c.req.param("adminCode"),
      c.get("body"),
      c.get("auth"),
      buildSecurityAuditContext(c)
    );
    return sendJson(c, result);
  }
);

router.get(
  "/users/:adminCode/permissions",
  permissionMiddleware(["permissions:read"]),
  async (c) => {
    const result = await adminSettingsService.getAdminUserPermissions(
      c.req.param("adminCode"),
      c.get("auth")
    );
    return sendJson(c, result);
  }
);

router.patch(
  "/users/:adminCode/permissions",
  permissionMiddleware(["permissions:update"]),
  async (c) => {
    const result = await adminSettingsService.updateAdminUserPermissions(
      c.req.param("adminCode"),
      c.get("body"),
      c.get("auth"),
      buildSecurityAuditContext(c)
    );
    return sendJson(c, result);
  }
);

export default router;
