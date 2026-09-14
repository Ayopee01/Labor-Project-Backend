// Import Library
import express from "express";
// Import Services
import * as lineDevService from "../services/line-dev.service";
import * as lineService from "../services/line.service";
// Import Utils
import { LINE_DEV_PAGE_HTML } from "../utils/line-dev-page";

const router = express.Router();

/* -------------------------------------- Line Routes -------------------------------------- */

router.get("/dev", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(LINE_DEV_PAGE_HTML);
});

router.get("/dev/submissions", async (_req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await lineDevService.listLineDevSubmissions());
  } catch (error) {
    next(error);
  }
});

router.post("/dev/submissions/:submissionId/confirm", async (req, res, next) => {
  try {
    res.json(
      await lineDevService.processLineDevSubmission(
        req.params.submissionId,
        "confirm",
        req.body,
      ),
    );
  } catch (error) {
    next(error);
  }
});

router.post("/dev/submissions/:submissionId/reject", async (req, res, next) => {
  try {
    res.json(
      await lineDevService.processLineDevSubmission(
        req.params.submissionId,
        "reject",
        req.body,
      ),
    );
  } catch (error) {
    next(error);
  }
});

router.post(
  "/webhook",
  async (req, res, next) => {
    try {
      const result = await lineService.handleLineWebhook(
        req.body,
        req.headers["x-line-signature"],
        req.rawBody
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
