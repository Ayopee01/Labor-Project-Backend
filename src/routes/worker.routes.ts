// Import Middlewares
import { ticketReferenceLogParam } from "../middlewares/log-context.middleware";
import authMiddleware from "../middlewares/auth.middleware";
import roleMiddleware from "../middlewares/role.middleware";
import sessionMiddleware from "../middlewares/session.middleware";
// Import Services
import * as realtimeNotificationService from "../services/shared/realtime-notification.service";
import * as workerService from "../services/worker.service";
// Import Utils
import { createRouter, getQuery, sendJson } from "../utils/http";

const router = createRouter();

/* -------------------------------------- Worker Application Routes -------------------------------------- */

router.get(
  "/app-version/check",
  async (c) => {
    const result = await workerService.checkMobileAppVersion(getQuery(c));
    return sendJson(c, result);
  }
);

router.use(authMiddleware);
router.use(sessionMiddleware);
router.use(roleMiddleware(["worker"]));

router.post(
  "/me/online",
  async (c) => {
    const result = await workerService.workerOnline(c.get("auth"));
    return sendJson(c, result);
  }
);

router.post(
  "/me/offline",
  async (c) => {
    const result = await workerService.workerOffline(c.get("auth"));
    return sendJson(c, result);
  }
);

router.post(
  "/me/break",
  async (c) => {
    const result = await workerService.workerBreak(c.get("auth"));
    return sendJson(c, result);
  }
);

router.get(
  "/me/status",
  async (c) => {
    const result = await workerService.getWorkerStatus(c.get("auth"));
    return sendJson(c, result);
  }
);

router.get(
  "/me/assignments/history",
  async (c) => {
    const result = await workerService.listWorkerAssignmentHistory(
      getQuery(c),
      c.get("auth")
    );
    return sendJson(c, result);
  }
);

router.get(
  "/me/earnings/summary",
  async (c) => {
    const result = await workerService.getWorkerEarningsSummary(
      getQuery(c),
      c.get("auth")
    );
    return sendJson(c, result);
  }
);

router.get(
  "/me/notifications",
  async (c) => {
    const result = await realtimeNotificationService.listWorkerNotifications(
      getQuery(c),
      c.get("auth"),
    );
    return sendJson(c, result);
  }
);

router.get(
  "/me/products/:productCode/packages",
  async (c) => {
    const result = await workerService.getWorkerProductPackageOptions(
      c.req.param("productCode"),
      c.get("auth")
    );
    return sendJson(c, result);
  }
);

router.post(
  "/me/assignments/:ticketNumber/accept",
  ticketReferenceLogParam("ticketNumber"),
  async (c) => {
    const result = await workerService.acceptWorkerAssignment(
      c.req.param("ticketNumber"),
      c.get("auth")
    );
    return sendJson(c, result);
  }
);

router.post(
  "/me/assignments/check-in-barcode",
  async (c) => {
    const result = await workerService.scanWorkerAssignment(
      c.get("body"),
      c.get("auth")
    );
    return sendJson(c, result);
  }
);

router.post(
  "/me/assignments/tickets/complete",
  async (c) => {
    const result =
      await workerService.completeWorkerAssignmentTicketFromBody(
        c.get("body"),
        c.get("auth")
      );
    return sendJson(c, result);
  }
);

export default router;
