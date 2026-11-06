// Import Services
import * as lineDevService from "../services/line-dev.service";
import * as lineService from "../services/line.service";
// Import Utils
import { createRouter, sendJson } from "../utils/http";
import { LINE_DEV_PAGE_HTML } from "../utils/line-dev-page";

const router = createRouter();

/* -------------------------------------- Line Routes -------------------------------------- */

router.get("/dev", (c) => {
  c.header("Cache-Control", "no-store");
  return c.html(LINE_DEV_PAGE_HTML);
});

router.get("/dev/submissions", async (c) => {
  c.header("Cache-Control", "no-store");
  return sendJson(c, await lineDevService.listLineDevSubmissions());
});

router.post("/dev/submissions/:submissionId/confirm", async (c) => {
  return sendJson(c, await lineDevService.processLineDevSubmission(
      c.req.param("submissionId"),
      "confirm",
      c.get("body"),
    ));
});

router.post("/dev/submissions/:submissionId/reject", async (c) => {
  return sendJson(c, await lineDevService.processLineDevSubmission(
      c.req.param("submissionId"),
      "reject",
      c.get("body"),
    ));
});

router.post("/dev/member-stalls", async (c) => {
  return sendJson(c, await lineDevService.addTestMemberStall(c.get("body")));
});

router.post(
  "/webhook",
  async (c) => {
    const result = await lineService.handleLineWebhook(
      c.get("body"),
      c.req.header("x-line-signature"),
      c.get("rawBody")
    );
    return sendJson(c, result);
  }
);

export default router;
