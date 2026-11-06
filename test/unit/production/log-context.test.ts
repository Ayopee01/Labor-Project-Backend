// Import Library
import assert from "node:assert/strict";
import test from "node:test";
import type { ErrorEvent } from "@sentry/node";
// Import Config
import { pinoLogger } from "../../../src/config/logger";
import { Sentry } from "../../../src/config/sentry";
// Import Utils
import { getLogContext, runWithChildLogContext, runWithLogContext, setLogContext } from "../../../src/utils/log-context";
import { logger } from "../../../src/utils/logger";

/* -------------------------------------- Setup -------------------------------------- */

// Config เก็บ log และ Sentry event ที่เกิดขึ้นระหว่าง test (ไม่เขียน stdout และไม่ส่งออกเน็ต)
const writtenLogs: Array<{ level: string; context: Record<string, unknown>; message: string }> = [];
const sentryEvents: ErrorEvent[] = [];

for (const level of ["info", "warn", "error"] as const) {
  (pinoLogger as unknown as Record<string, unknown>)[level] = (context: Record<string, unknown>, message: string) => {
    writtenLogs.push({ level, context, message });
  };
}

Sentry.init({
  dsn: "https://public@o0.ingest.sentry.io/0",
  beforeSend: (event) => {
    sentryEvents.push(event);
    return null;
  },
});

// Function ล้างค่าที่เก็บไว้ก่อนแต่ละ test
function resetCaptured(): void {
  writtenLogs.length = 0;
  sentryEvents.length = 0;
}

/* -------------------------------------- Tests -------------------------------------- */

test("logger merges the current log context and lets explicit fields win", () => {
  resetCaptured();

  runWithLogContext({ requestId: "req-1" }, () => {
    setLogContext({ ticketNumber: "25691019000001", ticketNo: "20261019000001" });
    logger.info("Something happened.", { ticketNo: "20261019000002" });
  });

  assert.equal(writtenLogs.length, 1);
  assert.equal(writtenLogs[0].context.requestId, "req-1");
  assert.equal(writtenLogs[0].context.ticketNumber, "25691019000001");
  assert.equal(writtenLogs[0].context.ticketNo, "20261019000002");
});

test("log contexts of concurrent requests never mix", async () => {
  const seen: Array<string | undefined> = [];

  await Promise.all(
    ["25691019000001", "25691019000002"].map((ticketNumber, index) =>
      runWithLogContext({ requestId: `req-${index}` }, async () => {
        setLogContext({ ticketNumber });
        await new Promise((resolve) => setTimeout(resolve, 10 - index * 5));
        seen.push(`${getLogContext()?.requestId}:${getLogContext()?.ticketNumber}`);
      })
    )
  );

  assert.deepEqual(seen.sort(), ["req-0:25691019000001", "req-1:25691019000002"]);
});

test("child log context inherits the parent but does not leak back into it", async () => {
  await runWithLogContext({ requestId: "req-parent", ticketNumber: "25691019000001" }, async () => {
    await runWithChildLogContext({ ticketNumber: "25691019000009" }, async () => {
      assert.equal(getLogContext()?.requestId, "req-parent");
      assert.equal(getLogContext()?.ticketNumber, "25691019000009");
    });

    assert.equal(getLogContext()?.ticketNumber, "25691019000001");
  });
});

test("child log context for another vehicle drops the ticket numbers of the parent vehicle", async () => {
  await runWithLogContext({ requestId: "req-gate", ticketNumber: "25691019000001", ticketNos: ["20261019000001"] }, async () => {
    await runWithChildLogContext({ ticketJobId: 9, ticketNumber: "25691019000009" }, async () => {
      assert.equal(getLogContext()?.requestId, "req-gate");
      assert.equal(getLogContext()?.ticketNumber, "25691019000009");
      assert.equal(getLogContext()?.ticketNos, undefined);
    });
  });
});

test("setLogContext ignores undefined values and does nothing outside a context", () => {
  setLogContext({ ticketNumber: "25691019000001" });
  assert.equal(getLogContext(), undefined);

  runWithLogContext({ ticketNumber: "25691019000001" }, () => {
    setLogContext({ ticketNumber: undefined, ticketNo: "20261019000001" });
    assert.equal(getLogContext()?.ticketNumber, "25691019000001");
    assert.equal(getLogContext()?.ticketNo, "20261019000001");
  });
});

test("logger.error reports to Sentry with ticket tags and without the request body", async () => {
  resetCaptured();

  runWithLogContext({ requestId: "req-sentry" }, () => {
    setLogContext({ ticketNumber: "25691019000001", ticketNos: ["20261019000001", "20261019000002"] });
    logger.error("Gate ticket was created but vendor notification failed.", {
      body: { TicketNumber: "25691019000001" },
      error: new Error("LINE is down"),
    });
  });
  await Sentry.flush(2000);

  assert.equal(sentryEvents.length, 1);
  assert.equal(sentryEvents[0].tags?.requestId, "req-sentry");
  assert.equal(sentryEvents[0].tags?.ticket_number, "25691019000001");
  assert.equal(sentryEvents[0].tags?.ticket_no, "20261019000001,20261019000002");
  assert.equal(sentryEvents[0].extra?.logMessage, "Gate ticket was created but vendor notification failed.");
  assert.equal(sentryEvents[0].extra?.body, undefined);
  assert.equal(sentryEvents[0].exception?.values?.[0]?.value, "LINE is down");
});

test("logger.warn and logger.error with reportToSentry=false never reach Sentry", async () => {
  resetCaptured();

  logger.warn("Failed to write SSE event.", { error: new Error("socket closed") });
  logger.error("Request completed.", { statusCode: 500 }, { reportToSentry: false });
  await Sentry.flush(2000);

  assert.equal(writtenLogs.length, 2);
  assert.equal(sentryEvents.length, 0);
});

test("the same error is sent to Sentry at most 5 times per minute while the server log keeps every one", async () => {
  resetCaptured();

  for (let index = 0; index < 7; index++) {
    logger.error("Failed to notify vendor LINE about stall job cancellation.", { error: new Error(`LINE timeout ${index}`) });
  }
  await Sentry.flush(2000);

  assert.equal(writtenLogs.length, 7);
  assert.equal(sentryEvents.length, 5);
});
