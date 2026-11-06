// Import Middlewares
import { ticketReferenceLogParam } from "../middlewares/log-context.middleware";
import permissionMiddleware from "../middlewares/permission.middleware";
// Import Services
import * as adminJobsService from "../services/admin-jobs.service";
import * as adminManualJobsService from "../services/admin-manual-jobs.service";
import * as adminWorkersService from "../services/admin-workers.service";
// Import Utils
import { createRouter, getQuery, sendJson } from "../utils/http";

const router = createRouter();

/* -------------------------------------- Admin Jobs Routes -------------------------------------- */

router.get(
  "/jobs/workers/status",
  permissionMiddleware(["jobs:read"]),
  async (c) => {
    const result = await adminWorkersService.listAdminWorkerStatuses(getQuery(c));
    return sendJson(c, result);
  }
);

router.post(
  "/jobs/workers/:workerCode/status/force",
  permissionMiddleware(["workers:force_status"]),
  async (c) => {
    const result = await adminWorkersService.forceAdminWorkerStatus(
      c.req.param("workerCode"),
      c.get("body"),
      c.get("auth")
    );
    return sendJson(c, result);
  }
);

router.post(
  "/vehicle-jobs/assignment/cancel",
  permissionMiddleware(["jobs:cancel"]),
  async (c) => {
    const result = await adminJobsService.cancelTicketJobAssignment(
      c.get("body"),
      c.get("auth")
    );
    return sendJson(c, result);
  }
);

/* -------------------------------------- Manual Job Entry Routes -------------------------------------- */

router.get(
  "/vehicle-jobs/manual-entries",
  permissionMiddleware(["jobs:manual_entry"]),
  async (c) => {
    const result = await adminManualJobsService.listManualJobs(getQuery(c));
    return sendJson(c, result);
  }
);

router.post(
  "/vehicle-jobs/manual-entries",
  permissionMiddleware(["jobs:manual_entry"]),
  async (c) => {
    const result = await adminManualJobsService.createManualJob(c.get("body"), c.get("auth"));
    return sendJson(c, result, 201);
  }
);

router.get(
  "/vehicle-jobs/manual-entries/:ticketNumber",
  ticketReferenceLogParam("ticketNumber"),
  permissionMiddleware(["jobs:manual_entry"]),
  async (c) => {
    const result = await adminManualJobsService.getManualJob(c.req.param("ticketNumber"));
    return sendJson(c, result);
  }
);

router.put(
  "/vehicle-jobs/manual-entries/:ticketNumber",
  ticketReferenceLogParam("ticketNumber"),
  permissionMiddleware(["jobs:manual_entry"]),
  async (c) => {
    const result = await adminManualJobsService.updateManualJob(
      c.req.param("ticketNumber"),
      c.get("body"),
      c.get("auth")
    );
    return sendJson(c, result);
  }
);

router.delete(
  "/vehicle-jobs/manual-entries/:ticketNumber",
  ticketReferenceLogParam("ticketNumber"),
  permissionMiddleware(["jobs:manual_entry"]),
  async (c) => {
    const result = await adminManualJobsService.deleteManualJob(
      c.req.param("ticketNumber"),
      c.get("body"),
      c.get("auth")
    );
    return sendJson(c, result);
  }
);

/* -------------------------------------- Vehicle Job Routes -------------------------------------- */

router.get(
  "/vehicle-jobs/operations",
  permissionMiddleware(["jobs:read"]),
  async (c) => {
    const result = await adminJobsService.listTicketJobOperations(getQuery(c));
    return sendJson(c, result);
  }
);

router.get(
  "/vehicle-jobs/history",
  permissionMiddleware(["jobs:read"]),
  async (c) => {
    const result = await adminJobsService.listTicketJobs(getQuery(c));
    return sendJson(c, result);
  }
);

router.get(
  "/vehicle-jobs/history/daily-worker-income",
  permissionMiddleware(["jobs:read"]),
  async (c) => {
    const result = await adminJobsService.listDailyWorkerIncome(getQuery(c));
    return sendJson(c, result);
  }
);

router.get(
  "/vehicle-jobs/history/daily-stall-fees",
  permissionMiddleware(["jobs:read"]),
  async (c) => {
    const result = await adminJobsService.listDailyStallFees(getQuery(c));
    return sendJson(c, result);
  }
);

router.get(
  "/vehicle-jobs/history/monthly-stall-fees",
  permissionMiddleware(["jobs:read"]),
  async (c) => {
    const result = await adminJobsService.listMonthlyStallFees(getQuery(c));
    return sendJson(c, result);
  }
);

router.get(
  "/vehicle-jobs/:ticketNumber/financials",
  ticketReferenceLogParam("ticketNumber"),
  permissionMiddleware(["jobs:read"]),
  async (c) => {
    const result = await adminJobsService.getTicketJobFinancials(
      c.req.param("ticketNumber")
    );
    return sendJson(c, result);
  }
);

router.get(
  "/vehicle-jobs/:ticketNumber/workers/:workerCode/payout-preview",
  ticketReferenceLogParam("ticketNumber"),
  permissionMiddleware(["jobs:read"]),
  async (c) => {
    const result = await adminJobsService.getWorkerPayoutPreview(
      c.req.param("ticketNumber"),
      c.req.param("workerCode"),
      getQuery(c)
    );
    return sendJson(c, result);
  }
);

router.post(
  "/vehicle-jobs/:ticketNumber/workers/:workerCode/booths",
  ticketReferenceLogParam("ticketNumber"),
  permissionMiddleware(["jobs:cancel"]),
  async (c) => {
    const result = await adminJobsService.addWorkerToBooths(
      c.req.param("ticketNumber"),
      c.req.param("workerCode"),
      c.get("body"),
      c.get("auth")
    );
    return sendJson(c, result);
  }
);

router.post(
  "/vehicle-jobs/:ticketNumber/assign-workers",
  ticketReferenceLogParam("ticketNumber"),
  permissionMiddleware(["jobs:assign"]),
  async (c) => {
    const result = await adminJobsService.assignTicketJobWorkers(
      c.req.param("ticketNumber"),
      c.get("body"),
      c.get("auth")
    );
    return sendJson(c, result, 201);
  }
);

router.post(
  "/vehicle-jobs/:ticketNumber/scan-deadline/extend",
  ticketReferenceLogParam("ticketNumber"),
  permissionMiddleware(["jobs:extend_deadline"]),
  async (c) => {
    const result = await adminJobsService.extendTicketJobScanDeadline(
      c.req.param("ticketNumber"),
      c.get("body"),
      c.get("auth")
    );
    return sendJson(c, result);
  }
);

router.post(
  "/vehicle-jobs/:ticketNumber/tickets/:ticketNo/stalls/:stallCode/override-count",
  ticketReferenceLogParam("ticketNumber"),
  ticketReferenceLogParam("ticketNo"),
  permissionMiddleware(["jobs:override_count"]),
  async (c) => {
    const result = await adminJobsService.overrideTicketProductCounts(
      c.req.param("ticketNumber"),
      c.req.param("ticketNo"),
      c.req.param("stallCode"),
      c.get("body"),
      c.get("auth")
    );
    return sendJson(c, result);
  }
);

router.post(
  "/vehicle-jobs/:ticketNumber/wait",
  ticketReferenceLogParam("ticketNumber"),
  permissionMiddleware(["jobs:wait"]),
  async (c) => {
    const result = await adminJobsService.changeTicketJobToWait(
      c.req.param("ticketNumber"),
      c.get("body"),
      c.get("auth")
    );
    return sendJson(c, result);
  }
);

router.post(
  "/vehicle-jobs/:ticketNumber/release-workers",
  ticketReferenceLogParam("ticketNumber"),
  permissionMiddleware(["jobs:release_workers"]),
  async (c) => {
    const result = await adminJobsService.releaseTicketJobWorkers(
      c.req.param("ticketNumber"),
      c.get("body"),
      c.get("auth")
    );
    return sendJson(c, result);
  }
);

export default router;
