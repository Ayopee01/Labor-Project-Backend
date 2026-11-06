// Import Middlewares
import permissionMiddleware from "../middlewares/permission.middleware";
// Import Services
import * as adminWorkersService from "../services/admin-workers.service";
// Import Utils
import { createRouter, getQuery, sendJson } from "../utils/http";
import { buildSecurityAuditContext } from "../utils/security-audit-context";

const router = createRouter();

/* -------------------------------------- Admin Workers Routes -------------------------------------- */

router.post(
  "/",
  permissionMiddleware(["workers:create"]),
  async (c) => {
    const result = await adminWorkersService.createUser(
      c.get("body"),
      c.get("auth"),
      buildSecurityAuditContext(c)
    );
    return sendJson(c, result, 201);
  }
);

router.get(
  "/",
  permissionMiddleware(["workers:read"]),
  async (c) => {
    const result = await adminWorkersService.listUsers(getQuery(c), c.get("auth"));
    return sendJson(c, result);
  }
);

router.get(
  "/:workerCode",
  permissionMiddleware(["workers:read"]),
  async (c) => {
    const result = await adminWorkersService.getUser(String(c.req.param("workerCode")), c.get("auth"));
    return sendJson(c, result);
  }
);

router.patch(
  "/:workerCode",
  permissionMiddleware(["workers:update"]),
  async (c) => {
    const result = await adminWorkersService.updateUser(
      String(c.req.param("workerCode")),
      c.get("body"),
      c.get("auth"),
      buildSecurityAuditContext(c)
    );
    return sendJson(c, result);
  }
);

router.patch(
  "/:workerCode/password",
  permissionMiddleware(["workers:reset_password"]),
  async (c) => {
    const result = await adminWorkersService.resetPassword(
      String(c.req.param("workerCode")),
      c.get("body"),
      c.get("auth"),
      buildSecurityAuditContext(c)
    );
    return sendJson(c, result);
  }
);

export default router;
