// Import Middlewares
import permissionMiddleware from "../middlewares/permission.middleware";
// Import Services
import * as adminAuditService from "../services/admin-audit.service";
// Import Utils
import { createRouter, getQuery, sendJson } from "../utils/http";

const router = createRouter();

/* -------------------------------------- Admin Audit Routes -------------------------------------- */

router.get(
  "/audit/workers/performance",
  permissionMiddleware(["jobs:read"]),
  async (c) => {
    const result = await adminAuditService.listWorkerPerformance(getQuery(c));
    return sendJson(c, result);
  }
);

router.get(
  "/audit/events",
  permissionMiddleware(["jobs:read"]),
  async (c) => {
    const result = await adminAuditService.listAuditEvents(
      getQuery(c),
      c.get("auth")?.permissions ?? []
    );
    return sendJson(c, result);
  }
);

export default router;
