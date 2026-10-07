// Import Library
import express from "express";
// Import Middlewares
import { ticketReferenceLogParam } from "../middlewares/log-context.middleware";
import gateClientAuthMiddleware from "../middlewares/gate-client-auth.middleware";
// Import Services
import * as gateService from "../services/gate.service";

const router = express.Router();

// เติม TicketNumber/TicketNo จาก path ลง log context (ใช้ค้น log/Sentry)
router.param("ticketNo", ticketReferenceLogParam("ticketNo"));

/* -------------------------------------- Gate Routes -------------------------------------- */

router.post(
  "/tickets",
  gateClientAuthMiddleware,
  async (req, res, next) => {
    try {
      const result = await gateService.createTicketJobFromGate(req.body, req.gateClient);
      res.status(result.Result === "REPLAYED" ? 200 : 201).json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/tickets/:ticketNo",
  gateClientAuthMiddleware,
  async (req, res, next) => {
    try {
      const result = await gateService.getGateTicket(req.params.ticketNo);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.put(
  "/tickets/:ticketNo",
  gateClientAuthMiddleware,
  async (req, res, next) => {
    try {
      const result = await gateService.updateGateTicket(req.params.ticketNo, req.body, req.gateClient);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/options",
  gateClientAuthMiddleware,
  async (req, res, next) => {
    try {
      const result = await gateService.getGateOptions(req.query);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
