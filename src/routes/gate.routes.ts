// Import Middlewares
import { ticketReferenceLogParam } from "../middlewares/log-context.middleware";
import gateClientAuthMiddleware from "../middlewares/gate-client-auth.middleware";
// Import Services
import * as gateService from "../services/gate.service";
// Import Utils
import { createRouter, getQuery, sendJson } from "../utils/http";

const router = createRouter();

/* -------------------------------------- Gate Routes -------------------------------------- */

router.post(
  "/tickets",
  gateClientAuthMiddleware,
  async (c) => {
    const result = await gateService.createTicketJobFromGate(c.get("body"), c.get("gateClient"));
    return sendJson(c, result, result.Result === "REPLAYED" ? 200 : 201);
  }
);

router.get(
  "/tickets/:ticketNo",
  ticketReferenceLogParam("ticketNo"),
  gateClientAuthMiddleware,
  async (c) => {
    const result = await gateService.getGateTicket(c.req.param("ticketNo"));
    return sendJson(c, result, 200);
  }
);

router.put(
  "/tickets/:ticketNo",
  ticketReferenceLogParam("ticketNo"),
  gateClientAuthMiddleware,
  async (c) => {
    const result = await gateService.updateGateTicket(c.req.param("ticketNo"), c.get("body"), c.get("gateClient"));
    return sendJson(c, result, 200);
  }
);

router.get(
  "/options",
  gateClientAuthMiddleware,
  async (c) => {
    const result = await gateService.getGateOptions(getQuery(c));
    return sendJson(c, result, 200);
  }
);

export default router;
