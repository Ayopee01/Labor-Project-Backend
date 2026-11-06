// Import Library
import assert from "node:assert/strict";
import { test } from "node:test";
// Import Utils
import { buildLocalizedNotification, hasNotificationTemplate } from "../../../src/utils/notification-localization";

/* -------------------------------------- Tests -------------------------------------- */

test("TICKET_COMPLETION_RESULT uses ticket.completion_auto_confirmed only for a vendor confirmation timeout", () => {
  const autoConfirmed = buildLocalizedNotification({
    type: "TICKET_COMPLETION_RESULT",
    lang: "TH",
    params: { boothCode: "B-01", submission_status: "COMPLETED", reason: "vendor_confirm_timeout" },
  });
  const vendorConfirmed = buildLocalizedNotification({
    type: "TICKET_COMPLETION_RESULT",
    lang: "TH",
    params: { boothCode: "B-01", submission_status: "COMPLETED" },
  });
  const rejected = buildLocalizedNotification({
    type: "TICKET_COMPLETION_RESULT",
    lang: "TH",
    params: { boothCode: "B-01", submission_status: "REJECT", reason: "vendor_confirm_timeout" },
  });

  assert.equal(autoConfirmed.key, "ticket.completion_auto_confirmed");
  assert.match(autoConfirmed.message, /B-01/);
  assert.equal(vendorConfirmed.key, "ticket.completion_confirmed");
  assert.equal(rejected.key, "ticket.completion_rejected");
});

test("ticket.completion_auto_confirmed has a template in every supported language", () => {
  for (const lang of ["TH", "MN", "CN", "EN"]) {
    assert.ok(hasNotificationTemplate(lang, "ticket.completion_auto_confirmed"), lang);
  }
});
