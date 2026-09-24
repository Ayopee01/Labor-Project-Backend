import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { addAdmin, addDispatchableJob, addPendingAssignment, addTicketForTicketJob, addWorker, getPassword, resetRouteTestState, restoreRouteTestLoader, signLineWebhookBody, startRouteTestServer, state, type TestServer } from "../helpers/app-test-harness";

let server: TestServer;
let password: typeof import("../../src/utils/password");
/* -------------------------------------- Test Helpers -------------------------------------- */

// Function เธเธฑเธ”เธเธฒเธฃ login worker เธชเธณเธซเธฃเธฑเธ test
async function loginWorker(accountId: number): Promise<{ token: string; worker: ReturnType<typeof addWorker> }> {
  const passwordHash = await password.hashPassword("Worker@123456");
  const worker = addWorker(accountId, passwordHash);
  const login = await server.request("POST", "/api/auth/login", {
    body: {
      username: worker.labor_code,
      password: "Worker@123456",
      device_id: `mobile-${accountId}`,
      device_name: "Worker Mobile",
    },
  });

  assert.equal(login.status, 200);

  return {
    token: login.body.access_token,
    worker,
  };
}

// Function เธเธฑเธ”เธเธฒเธฃ login job admin เธชเธณเธซเธฃเธฑเธ test
async function loginJobAdmin(accountId: number): Promise<{ token: string }> {
  const passwordHash = await password.hashPassword("Admin@123456");
  const admin = addAdmin(accountId, passwordHash);
  state.adminPermissions.set(admin.id, [
    "jobs:read",
    "jobs:assign",
    "jobs:cancel",
    "workers:force_status",
  ]);

  const login = await server.request("POST", "/api/auth/login", {
    body: {
      username: admin.username,
      password: "Admin@123456",
    },
  });

  assert.equal(login.status, 200);

  return {
    token: login.body.access_token,
  };
}

/* -------------------------------------- Test Lifecycle -------------------------------------- */

before(async () => {
  password = await getPassword();
  server = await startRouteTestServer();
});

beforeEach(() => {
  resetRouteTestState();
});

after(async () => {
  await server.close();
  restoreRouteTestLoader();
});

/* -------------------------------------- Gate Route Tests -------------------------------------- */

test("POST /api/line/webhook vendor reject marks assignment as REJECT and allows resubmit", async () => {
  const { token, worker } = await loginWorker(75);
  const job = addDispatchableJob(875, 1);
  const ticket = addTicketForTicketJob(job.id, 976);
  const assignment = addPendingAssignment(1076, job.id, worker.id);
  assignment.status = "SCANNED";
  assignment.scanned_at = new Date().toISOString();
  const products = state.ticketProducts.filter((product) => product.ticket_id === ticket.id);
  const market = state.marketJobs.find((item) => item.id === ticket.market_job_id)!;
  const submitResponse = await server.request("POST", `/api/workers/me/assignments/tickets/complete`, {
    token,
    body: {
      ticket_no: market.ticket_no,
      boothCode: ticket.boothCode,
      items: products.map((product) => ({
        productCode: product.productCode,
        packageCode: product.packageCode,
        confirmed_quantity: Number(product.quantity),
      })),
    },
  });
  assert.equal(submitResponse.status, 200);
  assert.equal(submitResponse.body.assignment_status, "DELIVERED");
  assert.equal(assignment.status, "DELIVERED");
  const lineMessage = state.lineMessages[0] as {
    data?: {
      messages?: Array<{
        contents?: {
          footer?: {
            contents?: Array<{
              action?: {
                label?: string;
                data?: string;
              };
            }>;
          };
        };
      }>;
    };
  };
  const rejectPostback = lineMessage.data?.messages?.[0]?.contents?.footer?.contents?.find(
    (button) => button.action?.label === "ไม่ถูกต้อง"
  )?.action?.data;
  assert.match(rejectPostback ?? "", /^token=/);
  assert.ok((rejectPostback ?? "").length <= 300);

  const rejectBody = {
    events: [
      {
        type: "postback",
        source: {
          userId: ticket.vendor_line_id,
        },
        postback: {
          data: `${rejectPostback}&reject_reason=Quantity mismatch`,
        },
      },
    ],
  };
  const rejectResponse = await server.request("POST", "/api/line/webhook", {
    headers: { "x-line-signature": signLineWebhookBody(rejectBody) },
    body: rejectBody,
  });

  assert.equal(rejectResponse.status, 200);
  assert.equal(rejectResponse.body.processed, 1);
  assert.equal(ticket.status, "REJECT");
  assert.equal(ticket.confirmation_status, "REJECT");
  assert.equal(assignment.status, "REJECT");

  assert.equal(state.ticketProductFinancials.length, 0);
  assert.equal(state.ticketWorkerPayments.length, 0);
  assert.equal(ticket.final_stall_amount ?? null, null);
  assert.equal(ticket.financialized_at ?? null, null);

  const rejectEvent = [...state.realtimeEvents].reverse().find(
    (event) =>
      Boolean(
        event &&
        typeof event === "object" &&
        (event as { type?: string }).type === "TICKET_COMPLETION_RESULT"
      )
  );
  assert.equal(
    (rejectEvent as { worker_payload?: Record<string, unknown> }).worker_payload
      ?.assignment_status,
    "REJECT"
  );

  const resubmitResponse = await server.request("POST", `/api/workers/me/assignments/tickets/complete`, {
    token,
    body: {
      ticket_no: market.ticket_no,
      boothCode: ticket.boothCode,
      items: products.map((product) => ({
        productCode: product.productCode,
        packageCode: product.packageCode,
        confirmed_quantity: Number(product.quantity),
      })),
    },
  });

  assert.equal(resubmitResponse.status, 200);
  assert.equal(resubmitResponse.body.assignment_status, "DELIVERED");
  assert.equal(assignment.status, "DELIVERED");
});

test("POST /api/line/webhook replies already-handled to the vendor when an earlier event races a resolved submission, and keeps processing later events in the same batch", async () => {
  async function submitAndGetRejectPostback(accountSuffix: number, jobSuffix: number) {
    const { token, worker } = await loginWorker(accountSuffix);
    const job = addDispatchableJob(jobSuffix, 1);
    const ticket = addTicketForTicketJob(job.id, jobSuffix * 100 + 1);
    const assignment = addPendingAssignment(jobSuffix * 100 + 2, job.id, worker.id);
    assignment.status = "SCANNED";
    assignment.scanned_at = new Date().toISOString();
    const products = state.ticketProducts.filter((product) => product.ticket_id === ticket.id);
    const market = state.marketJobs.find((item) => item.id === ticket.market_job_id)!;

    const submitResponse = await server.request(
      "POST",
      `/api/workers/me/assignments/tickets/complete`,
      {
        token,
        body: {
          ticket_no: market.ticket_no,
          boothCode: ticket.boothCode,
          items: products.map((product) => ({
            productCode: product.productCode,
            packageCode: product.packageCode,
            confirmed_quantity: Number(product.quantity),
          })),
        },
      },
    );

    assert.equal(submitResponse.status, 200);

    const lineMessage = state.lineMessages[state.lineMessages.length - 1] as {
      data?: {
        messages?: Array<{
          contents?: {
            footer?: {
              contents?: Array<{ action?: { label?: string; data?: string } }>;
            };
          };
        }>;
      };
    };
    const rejectPostback = lineMessage.data?.messages?.[0]?.contents?.footer?.contents?.find(
      (button) => button.action?.label === "ไม่ถูกต้อง",
    )?.action?.data;

    assert.match(rejectPostback ?? "", /^token=/);

    return { ticket, rejectPostback: rejectPostback ?? "" };
  }

  const first = await submitAndGetRejectPostback(76, 876);
  const second = await submitAndGetRejectPostback(77, 877);

  // จำลอง Race ที่ทำให้ event แรกใน batch นี้ throw TicketSubmissionAlreadyResolvedError ตอน
  // ประมวลผลจริง (เช่น auto-confirm timeout ชนะไปพอดีก่อนหน้า ticket จึงไม่ใช่ DELIVERED อีกต่อไป
  // ตอน webhook นี้มาถึง) — handleLineWebhook ต้องจับ error นี้แล้วตอบ "already handled" กลับ
  // vendor แทนที่จะเงียบ พร้อมยังประมวลผล event ถัดไปในชุดเดียวกันต่อไปได้ตามปกติ
  first.ticket.status = "WAIT";

  const raceBody = {
    events: [
      {
        type: "postback",
        source: { userId: first.ticket.vendor_line_id },
        postback: { data: `${first.rejectPostback}&reject_reason=Race` },
      },
      {
        type: "postback",
        source: { userId: second.ticket.vendor_line_id },
        postback: { data: `${second.rejectPostback}&reject_reason=Quantity mismatch` },
      },
    ],
  };
  const response = await server.request("POST", "/api/line/webhook", {
    headers: { "x-line-signature": signLineWebhookBody(raceBody) },
    body: raceBody,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.processed, 2);
  assert.equal(first.ticket.status, "WAIT");
  assert.equal(second.ticket.status, "REJECT");

  const alreadyHandledMessage = state.lineMessages.find(
    (message) => (message as { name?: string }).name === "send-vendor-ticket-already-handled",
  ) as { data?: { to?: string } } | undefined;

  assert.ok(alreadyHandledMessage, "expected an already-handled reply to be sent to the raced vendor");
  assert.equal(alreadyHandledMessage?.data?.to, first.ticket.vendor_line_id);
});

test("POST /api/line/webhook replies the sender's LINE user id via the Reply API when they text \"id\" (case-insensitive, trimmed) — does not go through the push queue", async () => {
  const messageBody = {
    events: [
      {
        type: "message",
        replyToken: "reply-token-abc123",
        source: { userId: "Utest-id-reply-0001" },
        message: { type: "text", text: "  Id  " },
      },
    ],
  };
  const response = await server.request("POST", "/api/line/webhook", {
    headers: { "x-line-signature": signLineWebhookBody(messageBody) },
    body: messageBody,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.processed, 1);

  const replyMessage = state.lineMessages.find(
    (message) => (message as { name?: string }).name === "send-line-reply",
  ) as { data?: { replyToken?: string; messages?: Array<{ type: string; text: string }> } } | undefined;

  assert.ok(replyMessage, "expected a reply to be sent via the Reply API");
  assert.equal(replyMessage?.data?.replyToken, "reply-token-abc123");
  assert.equal(replyMessage?.data?.messages?.[0]?.text, "Your user ID: Utest-id-reply-0001");
});

test("POST /api/line/webhook does not reply for a text message that isn't exactly \"id\"", async () => {
  const messageBody = {
    events: [
      {
        type: "message",
        replyToken: "reply-token-xyz789",
        source: { userId: "Utest-id-reply-0002" },
        message: { type: "text", text: "hello there" },
      },
    ],
  };
  const response = await server.request("POST", "/api/line/webhook", {
    headers: { "x-line-signature": signLineWebhookBody(messageBody) },
    body: messageBody,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.processed, 0);
  assert.equal(
    state.lineMessages.find((message) => (message as { name?: string }).name === "send-line-reply"),
    undefined,
  );
});

test("POST /api/workers/me/assignments/tickets/complete snapshots worker_count_snapshot on each submission; a worker cancelled before resubmit lowers only the new snapshot", async () => {
  const { token: workerAToken, worker: workerA } = await loginWorker(76);
  const workerB = addWorker(77);
  const workerC = addWorker(78);
  const { token: adminToken } = await loginJobAdmin(879);

  const job = addDispatchableJob(877, 2);
  const ticket = addTicketForTicketJob(job.id, 977);
  const market = state.marketJobs.find((item) => item.id === ticket.market_job_id)!;
  const products = state.ticketProducts.filter((product) => product.ticket_id === ticket.id);

  const assignmentA = addPendingAssignment(1077, job.id, workerA.id);
  const assignmentB = addPendingAssignment(1078, job.id, workerB.id);
  const assignmentC = addPendingAssignment(1079, job.id, workerC.id);

  assignmentA.status = "SCANNED";
  assignmentB.status = "SCANNED";
  assignmentC.status = "SCANNED";

  // Submission #1: ทั้ง 3 คนยัง WORKING ณ ตอน Submit
  const firstSubmitResponse = await server.request(
    "POST",
    `/api/workers/me/assignments/tickets/complete`,
    {
      token: workerAToken,
      body: {
        ticket_no: market.ticket_no,
        boothCode: ticket.boothCode,
        items: products.map((product) => ({
          productCode: product.productCode,
          packageCode: product.packageCode,
          confirmed_quantity: Number(product.quantity),
        })),
      },
    },
  );

  assert.equal(firstSubmitResponse.status, 200);

  const firstSubmission = state.completionSubmissions.at(-1);

  assert.ok(firstSubmission);
  assert.equal(firstSubmission.worker_count_snapshot, 3);

  // Vendor กด Reject ผ่าน LINE
  const lineMessage = state.lineMessages.at(-1) as {
    data?: {
      messages?: Array<{
        contents?: {
          footer?: {
            contents?: Array<{ action?: { label?: string; data?: string } }>;
          };
        };
      }>;
    };
  };
  const rejectPostback = lineMessage.data?.messages?.[0]?.contents?.footer?.contents?.find(
    (button) => button.action?.label === "ไม่ถูกต้อง",
  )?.action?.data;

  assert.match(rejectPostback ?? "", /^token=/);

  const rejectBody = {
    events: [
      {
        type: "postback",
        source: { userId: ticket.vendor_line_id },
        postback: { data: `${rejectPostback}&reject_reason=Quantity mismatch` },
      },
    ],
  };
  const rejectResponse = await server.request("POST", "/api/line/webhook", {
    headers: { "x-line-signature": signLineWebhookBody(rejectBody) },
    body: rejectBody,
  });

  assert.equal(rejectResponse.status, 200);

  // Admin ยกเลิก Worker C ก่อนส่งยอดใหม่ (Worker C ออกจากงาน)
  const cancelResponse = await server.request(
    "POST",
    "/api/admin/vehicle-jobs/assignment/cancel",
    {
      token: adminToken,
      body: {
        ticket_number: job.ticket_number,
        worker_code: workerC.labor_code,
        reason_code: "TEST_WORKER_LEFT",
        reason_text: "test",
      },
    },
  );

  assert.equal(cancelResponse.status, 200);

  // Submission #2 (resubmit): เหลือ Worker A + B WORKING เท่านั้น
  const secondSubmitResponse = await server.request(
    "POST",
    `/api/workers/me/assignments/tickets/complete`,
    {
      token: workerAToken,
      body: {
        ticket_no: market.ticket_no,
        boothCode: ticket.boothCode,
        items: products.map((product) => ({
          productCode: product.productCode,
          packageCode: product.packageCode,
          confirmed_quantity: Number(product.quantity),
        })),
      },
    },
  );

  assert.equal(secondSubmitResponse.status, 200);

  const submissions = state.completionSubmissions
    .filter((submission) => submission.ticket_id === ticket.id)
    .sort((left, right) => left.id - right.id);

  assert.equal(submissions.length, 2);
  // Submission #1 ต้องไม่ถูกแก้ย้อนหลัง ยังเป็น 3 เหมือนเดิม
  assert.equal(submissions[0].worker_count_snapshot, 3);
  // Submission #2 ต้อง Snapshot ใหม่ = 2 ไม่ใช่ copy จาก #1
  assert.equal(submissions[1].worker_count_snapshot, 2);

  // Work History Booth ต้องใช้ค่าจาก Submission ล่าสุด (2) ไม่ใช่ Roster ปัจจุบัน
  const historyResponse = await server.request(
    "GET",
    "/api/admin/vehicle-jobs/history",
    { token: adminToken },
  );

  const item = historyResponse.body.data[0];

  assert.equal(item.markets[0].booths[0].worker_count, 2);
});

/* -------------------------------------- LINE Dev Tester Route Tests -------------------------------------- */
// หมายเหตุ: /api/line/dev/* endpoints เหล่านี้ตั้งใจไม่มี auth (dev tester tool) จึงยิง request ตรงๆ
// โดยไม่ต้อง token

// หมายเหตุ: ไม่มี test สำหรับ 500 TICKET_FINANCIAL_STATE_INVALID / TICKET_FINAL_STALL_AMOUNT_INVALID
// (requireFinalStallAmountBaht ใน src/services/line.service.ts) ในไฟล์นี้ แม้จะระบุ precondition จริงที่
// trigger ได้ (Vendor กด "ให้คะแนน" ผ่าน vendor_rate_ticket LINE postback บน Booth ที่ status COMPLETED
// แล้วแต่ยังไม่ Financialize เพราะ Booth อื่นในใบเดียวกันยังไม่ Terminal ครบ — เห็นสภาพนี้ได้จริงจาก test
// "worker globally cancelled before Business Ticket roster locks..." ใน admin-jobs.routes.test.ts ที่
// firstTicket.status เป็น COMPLETED ทั้งที่ financialized_at ยังเป็น null) เพราะ handleLineWebhook (บรรทัด
// ~544-622 ของ line.service.ts) ครอบทุก event ด้วย try/catch ที่ดัก error ทั่วไปแค่ logger.error แล้ว
// continue loop ต่อ ไม่ throw ออกมาให้ route response เห็นเลย — POST /api/line/webhook จะตอบ 200 เสมอ
// พร้อม processed count ที่ไม่รวม event นี้ ไม่มี response.status/response.body.code ให้ assert ตรงกับ error
// code จริงได้เลยในทางปฏิบัติ

test("POST /api/line/dev/submissions/:id/confirm returns 404 SUBMISSION_NOT_FOUND when the submission id does not exist", async () => {
  const response = await server.request(
    "POST",
    "/api/line/dev/submissions/999999999/confirm",
    { body: {} },
  );

  assert.equal(response.status, 404);
  assert.equal(response.body.code, "SUBMISSION_NOT_FOUND");
});

test("POST /api/line/dev/submissions/:id/confirm returns 409 SUBMISSION_ALREADY_HANDLED when the same submission is confirmed a second time", async () => {
  const { token: workerToken, worker } = await loginWorker(81);
  const job = addDispatchableJob(881, 1);
  const ticket = addTicketForTicketJob(job.id, 981);
  const assignment = addPendingAssignment(1081, job.id, worker.id);
  assignment.status = "SCANNED";
  assignment.scanned_at = new Date().toISOString();

  const market = state.marketJobs.find((item) => item.id === ticket.market_job_id)!;
  const products = state.ticketProducts.filter((product) => product.ticket_id === ticket.id);

  const submitResponse = await server.request(
    "POST",
    "/api/workers/me/assignments/tickets/complete",
    {
      token: workerToken,
      body: {
        ticket_no: market.ticket_no,
        boothCode: ticket.boothCode,
        items: products.map((product, index) => ({
          productCode: product.productCode,
          packageCode: product.packageCode,
          confirmed_quantity: index === 0 ? 10 : 4,
        })),
      },
    },
  );

  assert.equal(submitResponse.status, 200);
  assert.equal(ticket.status, "DELIVERED");

  const submission = state.completionSubmissions.at(-1);

  assert.ok(submission, "completion submission must exist after submit");

  const firstConfirmResponse = await server.request(
    "POST",
    `/api/line/dev/submissions/${submission!.id}/confirm`,
    { body: {} },
  );

  assert.equal(firstConfirmResponse.status, 200, JSON.stringify(firstConfirmResponse.body));
  assert.equal(ticket.status, "COMPLETED");

  const secondConfirmResponse = await server.request(
    "POST",
    `/api/line/dev/submissions/${submission!.id}/confirm`,
    { body: {} },
  );

  assert.equal(secondConfirmResponse.status, 409);
  assert.equal(secondConfirmResponse.body.code, "SUBMISSION_ALREADY_HANDLED");
  // ต้องไม่ถูกประมวลผลซ้ำ (ยังเป็นผลจากครั้งแรกเท่านั้น)
  assert.equal(ticket.status, "COMPLETED");
});
