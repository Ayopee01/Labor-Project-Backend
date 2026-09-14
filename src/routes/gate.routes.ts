// Import Library
import express from "express";
// Import Middleware
import gateClientAuthMiddleware from "../middlewares/gate-client-auth.middleware";
// Import Services
import * as gateService from "../services/gate.service";

const router = express.Router();

/* -------------------------------------- Gate Routes -------------------------------------- */

router.post(
  "/tickets",
  gateClientAuthMiddleware,
  async (req, res, next) => {
    try {
      const result = await gateService.createTicketJobFromGate(req.body);
      res.status(result.Result === "REPLAYED" ? 200 : 201).json(result);
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