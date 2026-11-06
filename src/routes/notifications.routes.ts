// Import Library
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
// Import Middlewares
import permissionMiddleware from "../middlewares/permission.middleware";
// Import Services
import * as notificationsService from "../services/notifications.service";
// Import Utils
import { createRouter, getStreamResponse } from "../utils/http";

const router = createRouter();

/* -------------------------------------- Notifications Routes -------------------------------------- */

router.get(
  "/",
  permissionMiddleware(["jobs:read"]),
  async (c) => {
    const auth = c.get("auth");

    if (!auth) {
      throw new Error("Authentication payload is missing.");
    }

    await notificationsService.subscribeAdminEvents(
      getStreamResponse(c),
      auth,
      c.req.header("Last-Event-ID")?.trim() || undefined
    );
    return RESPONSE_ALREADY_SENT;
  }
);

export default router;
