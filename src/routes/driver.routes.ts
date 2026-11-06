// Import Library
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
// Import Middlewares
import { ticketReferenceLogParam } from "../middlewares/log-context.middleware";
import driverSessionMiddleware from "../middlewares/driver-session.middleware";
import { driverQrRateLimitMiddleware } from "../middlewares/driver-qr-rate-limit.middleware";
// Import Services
import * as driverService from "../services/driver.service";
// Import Utils
import { createRouter, getStreamResponse, sendJson } from "../utils/http";

const router = createRouter();

/* -------------------------------------- Driver Routes -------------------------------------- */

router.post(
  "/qr-sessions",
  driverQrRateLimitMiddleware,
  async (c) => {
    const result = await driverService.createDriverSessionFromQr(c.get("body"));
    return sendJson(c, result, 201);
  }
);

router.get(
  "/jobs/current",
  driverSessionMiddleware,
  async (c) => {
    const result = await driverService.getDriverCurrentJob(c.get("driverSession"));
    return sendJson(c, result);
  }
);

router.patch(
  "/jobs/:ticketNumber/dispatch",
  ticketReferenceLogParam("ticketNumber"),
  driverSessionMiddleware,
  async (c) => {
    const result = await driverService.changeDriverJobDispatch(
      c.req.param("ticketNumber"),
      c.get("body"),
      c.get("driverSession")
    );
    return sendJson(c, result);
  }
);

// SSE stream ให้ Driver Web รับข้อมูลงานรถแบบ realtime
router.get(
  "/jobs/stream",
  driverSessionMiddleware,
  async (c) => {
    await driverService.subscribeDriverJobStream(getStreamResponse(c), c.get("driverSession")!);
    return RESPONSE_ALREADY_SENT;
  }
);

export default router;
