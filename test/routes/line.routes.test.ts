// Import Library
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
// Import Helpers
import { addAdmin, addDispatchableJob, addPendingAssignment, addTicketForTicketJob, addWorker, getPassword, getWorkerDispatch, resetRouteTestState, restoreRouteTestLoader, signLineWebhookBody, startRouteTestServer, state, type TestServer } from "../helpers/app-test-harness";

let server: TestServer;
let password: typeof import("../../src/utils/password");
let workerDispatch: typeof import("../../src/queues/worker-dispatch");

/* -------------------------------------- Test Helpers -------------------------------------- */

// Function login worker
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

// Function หา LINE message ตามชื่อ job และผู้รับ
function findLineMessages(name: string, to?: string): unknown[] {
  return state.lineMessages.filter((message) => {
    const item = message as { name?: string; data?: { to?: string } };

    return item.name === name && (to === undefined || item.data?.to === to);
  });
}

// Function ส่ง postback เข้า LINE webhook ในนามผู้ใช้ LINE
async function sendLinePostback(lineUserId: string, data: string) {
  const body = {
    events: [{ type: "postback", source: { userId: lineUserId }, postback: { data } }],
  };

  return server.request("POST", "/api/line/webhook", {
    headers: { "x-line-signature": signLineWebhookBody(body) },
    body,
  });
}

// Function ดึง postback ให้คะแนนจากข้อความที่ส่งถึงผู้ใช้ LINE
function findRatingPostback(lineUserId: string, score: number): string | undefined {
  const message = JSON.stringify(findLineMessages("send-vendor-ticket-rating-prompt", lineUserId).at(-1));

  return new RegExp(`"data":"(token=[^"]+&score=${score})"`).exec(message)?.[1];
}

// Function login job admin
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
  workerDispatch = await getWorkerDispatch();
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

test("POST /api/line/webhook vendor rating on the first booth of a multi-booth business ticket sends the stall amount before the ticket is financialized", async () => {
  const { token, worker } = await loginWorker(78);
  const job = addDispatchableJob(878, 1);
  const firstTicket = addTicketForTicketJob(job.id, 979);
  const secondTicket = addTicketForTicketJob(job.id, 980);
  const market = state.marketJobs.find((item) => item.id === firstTicket.market_job_id)!;

  // Business Ticket ใบเดียวสองแผง แผงที่สองยังไม่จบ จึงยังปิดยอดทั้งใบไม่ได้
  assert.equal(secondTicket.market_job_id, market.id);
  secondTicket.status = "WAIT";
  market.booth_count = 2;

  const assignment = addPendingAssignment(1079, job.id, worker.id);
  assignment.status = "SCANNED";
  assignment.scanned_at = new Date().toISOString();
  const products = state.ticketProducts.filter((product) => product.ticket_id === firstTicket.id);
  const submitResponse = await server.request("POST", `/api/workers/me/assignments/tickets/complete`, {
    token,
    body: {
      ticket_no: market.ticket_no,
      boothCode: firstTicket.boothCode,
      items: products.map((product, index) => ({
        productCode: product.productCode,
        packageCode: product.packageCode,
        confirmed_quantity: index === 0 ? 10 : 4,
      })),
    },
  });
  assert.equal(submitResponse.status, 200);

  const reviewMessage = JSON.stringify(state.lineMessages.at(-1));
  const confirmPostback = /"label":"ถูกต้อง","data":"(token=[^"]+)"/.exec(reviewMessage)?.[1];
  assert.ok(confirmPostback, "Confirm postback must exist.");

  // Vendor ยืนยันยอด -> แผงแรก COMPLETED และมียอดแผงทันที แต่ทั้งใบยังไม่ปิดยอด
  const confirmBody = {
    events: [{ type: "postback", source: { userId: firstTicket.vendor_line_id }, postback: { data: confirmPostback } }],
  };
  const confirmResponse = await server.request("POST", "/api/line/webhook", {
    headers: { "x-line-signature": signLineWebhookBody(confirmBody) },
    body: confirmBody,
  });

  assert.equal(confirmResponse.body.processed, 1);
  assert.equal(firstTicket.status, "COMPLETED");
  assert.equal(firstTicket.final_stall_amount, "34.00");
  assert.equal(firstTicket.financialized_at ?? null, null);
  assert.equal(market.financialized_at ?? null, null);
  assert.ok(products.every((product) => product.product_charge));

  const ratingMessage = JSON.stringify(
    state.lineMessages.find((message) => (message as { name?: string }).name === "send-vendor-ticket-rating-prompt"),
  );
  const ratingPostback = /"data":"(token=[^"]+&score=5)"/.exec(ratingMessage)?.[1];
  assert.ok(ratingPostback, "Rating postback must exist.");

  // Vendor ให้คะแนน -> ต้องได้ข้อความยอดชำระทันที แม้แผงที่สองยังไม่จบ
  const ratingBody = {
    events: [{ type: "postback", source: { userId: firstTicket.vendor_line_id }, postback: { data: ratingPostback } }],
  };
  const ratingResponse = await server.request("POST", "/api/line/webhook", {
    headers: { "x-line-signature": signLineWebhookBody(ratingBody) },
    body: ratingBody,
  });

  assert.equal(ratingResponse.body.processed, 1);

  const ratingResult = state.lineMessages.find(
    (message) => (message as { name?: string }).name === "send-vendor-ticket-rating-result",
  );
  assert.ok(ratingResult, "Rating result with stall amount must be sent.");
  assert.match(JSON.stringify(ratingResult), /34\.00/);

  // สมาชิกคนอื่นของแผงได้ยอดชำระด้วย
  const memberSummary = findLineMessages(
    "send-vendor-ticket-payment-summary",
    `${firstTicket.vendor_line_id}-member`,
  );
  assert.equal(memberSummary.length, 1);
  assert.match(JSON.stringify(memberSummary[0]), /34\.00/);
});

test("vendor confirmation timeout auto-confirms and sends every booth LINE target a confirmed notice plus a rating prompt; first rater sets the score, everyone receives the stall amount, later raters get no reply", async () => {
  const { token, worker } = await loginWorker(79);
  const job = addDispatchableJob(879, 1);
  const ticket = addTicketForTicketJob(job.id, 981);
  const market = state.marketJobs.find((item) => item.id === ticket.market_job_id)!;
  const ownerLineUserId = ticket.vendor_line_id as string;
  const memberLineUserId = `${ownerLineUserId}-member`;
  const assignment = addPendingAssignment(1080, job.id, worker.id);
  assignment.status = "SCANNED";
  assignment.scanned_at = new Date().toISOString();
  const products = state.ticketProducts.filter((product) => product.ticket_id === ticket.id);

  const submitResponse = await server.request("POST", `/api/workers/me/assignments/tickets/complete`, {
    token,
    body: {
      ticket_no: market.ticket_no,
      boothCode: ticket.boothCode,
      items: products.map((product, index) => ({
        productCode: product.productCode,
        packageCode: product.packageCode,
        confirmed_quantity: index === 0 ? 10 : 4,
      })),
    },
  });
  assert.equal(submitResponse.status, 200);

  // Vendor ไม่ตอบ -> timeout job ยืนยันให้อัตโนมัติ
  workerDispatch.startAssignmentTimeoutProcessing();
  const processor = state.workerProcessors.get(process.env.BULLMQ_ASSIGNMENT_TIMEOUT_QUEUE as string);
  assert.ok(processor, "Assignment timeout processor must be registered.");
  const submission = state.completionSubmissions.at(-1);
  assert.ok(submission);

  await processor({ data: { ticketId: ticket.id, submissionId: submission.id, kind: "vendor_confirm" } });

  assert.equal(ticket.status, "COMPLETED");
  assert.equal(ticket.final_stall_amount, "34.00");

  // ทุกคนในแผงได้ข้อความยืนยันอัตโนมัติ และปุ่มให้คะแนนของตัวเอง
  for (const lineUserId of [ownerLineUserId, memberLineUserId]) {
    const completion = findLineMessages("send-vendor-ticket-completion-result", lineUserId);
    assert.equal(completion.length, 1);
    assert.match(JSON.stringify(completion[0]), /ระบบยืนยันข้อมูลอัตโนมัติ/);
    assert.ok(findRatingPostback(lineUserId, 4), `Rating prompt must be sent to ${lineUserId}.`);
  }

  // สมาชิกกดก่อน -> คะแนนของแผง = 4 และเจ้าของได้ยอดชำระด้วย
  const memberRating = await sendLinePostback(memberLineUserId, findRatingPostback(memberLineUserId, 4)!);
  assert.equal(memberRating.body.processed, 1);
  assert.equal(state.ticketRatings.find((rating) => rating.ticket_id === ticket.id)?.score, 4);
  assert.match(JSON.stringify(findLineMessages("send-vendor-ticket-rating-result", memberLineUserId)), /34\.00/);
  assert.equal(findLineMessages("send-vendor-ticket-payment-summary", ownerLineUserId).length, 1);

  // เจ้าของกดทีหลัง -> คะแนนไม่เปลี่ยน และไม่ตอบกลับใคร (ได้สรุปไปแล้วตอนสมาชิกให้คะแนน)
  const messageCountBeforeOwnerRating = state.lineMessages.length;
  const ownerRating = await sendLinePostback(ownerLineUserId, findRatingPostback(ownerLineUserId, 2)!);
  assert.equal(ownerRating.body.processed, 1);
  assert.equal(state.ticketRatings.find((rating) => rating.ticket_id === ticket.id)?.score, 4);
  assert.equal(state.lineMessages.length, messageCountBeforeOwnerRating);
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

  // จำลอง event แรกถูก resolve ไปแล้ว ต้องตอบ already handled แล้วทำ event ถัดไปต่อ
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

// /api/line/dev/* ตั้งใจไม่มี auth (dev tester tool) จึงยิง request ตรงๆ โดยไม่ใช้ token

// ไม่มี test error ของ requireFinalStallAmountBaht เพราะ webhook จับ error ทุก event แล้วตอบ 200 เสมอ

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
