// Import Library
import crypto from "crypto";
// Import Config
import { withTransaction } from "../db/prisma";
import { TICKET_STATUS } from "../constants/status";
// Import Repositories
import * as lineRepository from "../repositories/line.repository";
import * as boothJobRepository from "../repositories/shared/booth-job.repository";
import { TicketSubmissionAlreadyResolvedError } from "../repositories/shared/booth-job.repository";
import * as lineActionTokenRepository from "../repositories/shared/line-action-token.repository";
import * as ticketJobRepository from "../repositories/shared/ticket-job.repository";
// Import Services
import { publishRealtimeEvent } from "./shared/realtime-notification.service";
import { publishDriverJobUpdate } from "./driver-stream.service";
import { applyVendorTicketCompletionResult, publishTicketCompletionResultEvent } from "./shared/ticket-completion.service";
// Import Queues
import { enqueueLoggedLineMessage, sendLineReplyMessage } from "../queues/line-message-queue";
import { returnCompletedWorkersToQueue } from "../queues/worker-dispatch";
import { removeVendorConfirmationTimeout } from "../queues/worker-queue";
// Import Types
import { MAX_RATING_SCORE, MIN_RATING_SCORE } from "../types/line.type";
import type { LineMessage, LineWebhookEvent, VendorTicketAction, VendorTicketActionTokenPayload } from "../types/line.type";
import type { BoothJobDto, TicketJobDetailResponse } from "../types/worker.type";
// Import Utils
import ApiError from "../utils/api-error";
import { buildVendorCompletionResultFlexMessage, buildVendorRatingPromptFlexMessage, buildVendorRatingResultFlexMessages } from "../utils/line-flex-message";
import { logger } from "../utils/logger";
import { buildTicketCompletionResultExtraFields, buildWorkerTicketPayload } from "../utils/ticket-payload";

/* -------------------------------------- Functions -------------------------------------- */

// Function ตรวจ LINE signature ของ webhook ด้วย channel secret
function verifyLineSignature(rawBody: string | undefined, signature: unknown): void {
  const secret = process.env.LINE_CHANNEL_SECRET;

  if (!secret) {
    throw new ApiError(
      503,
      "LINE_WEBHOOK_NOT_CONFIGURED",
      "LINE webhook is not configured."
    );
  }

  if (!rawBody || typeof signature !== "string") {
    throw new ApiError(401, "INVALID_LINE_SIGNATURE", "LINE signature is required.");
  }

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");
  const expectedBuffer = Buffer.from(expectedSignature);
  const actualBuffer = Buffer.from(signature);

  if (
    expectedBuffer.length !== actualBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    throw new ApiError(401, "INVALID_LINE_SIGNATURE", "LINE signature is invalid.");
  }
}

// Function แยก action, token และค่าอื่นจาก LINE postback data
function parseLinePostback(data: string | undefined): {
  action: VendorTicketAction | null;
  token: string | null;
  rejectReason: string | null;
  score: number | null;
} {
  if (!data) {
    return {
      action: null,
      token: null,
      rejectReason: null,
      score: null,
    };
  }

  const params = new URLSearchParams(data);
  const action = params.get("action");
  const rawRejectReason =
    params.get("reject_reason") ?? params.get("reason") ?? null;
  const rejectReason = rawRejectReason?.trim() || null;
  const rawScore = params.get("score");
  const score =
    rawScore && /^\d+$/.test(rawScore) ? Number(rawScore) : null;

  return {
    action:
      action === "vendor_confirm_completion" ||
        action === "vendor_reject_completion" ||
        action === "vendor_rate_ticket"
        ? action
        : null,
    token: params.get("token"),
    rejectReason,
    score,
  };
}

// Function ตรวจว่าค่าเป็น action ของ Vendor ที่รองรับ
function isVendorTicketAction(value: unknown): value is VendorTicketAction {
  return (
    value === "vendor_confirm_completion" ||
    value === "vendor_reject_completion" ||
    value === "vendor_rate_ticket"
  );
}

// Function ตรวจ LINE action token ว่ายังใช้ได้และตรงกับ action
async function verifyLineActionToken(
  token: string,
  expectedAction?: VendorTicketAction
): Promise<VendorTicketActionTokenPayload | null> {
  const storedToken = await lineRepository.findLineActionToken(token);

  if (!storedToken) {
    return null;
  }

  if (
    !isVendorTicketAction(storedToken.action) ||
    (expectedAction && storedToken.action !== expectedAction) ||
    Date.parse(storedToken.expires_at) <= Date.now()
  ) {
    return null;
  }

  // ไม่เช็ค used_at ที่นี่ เพราะปุ่มยืนยัน/ตีกลับต้องตอบ already_handled ได้ทุกครั้งที่กดซ้ำ
  return {
    token_type: "vendor_ticket_action",
    id: storedToken.id,
    action: storedToken.action,
    ticket_id: storedToken.ticket_id,
    submission_id: storedToken.submission_id,
    boothCode: storedToken.boothCode,
    iat: Math.floor(Date.parse(storedToken.created_at) / 1000),
    exp: Math.floor(Date.parse(storedToken.expires_at) / 1000),
  };
}

// Function ดึง LINE user ID ของผู้ส่ง event
function getLineUserId(event: LineWebhookEvent): string | null {
  return event.source?.userId ?? event.source?.user_id ?? null;
}

// Function ตอบ LINE user id กลับในแชทเมื่อพิมพ์ "id" (ใช้ช่วยตั้งค่าทดสอบ ผ่าน Reply API)
async function handleGetUserIdTextMessage(
  event: LineWebhookEvent,
  lineUserId: string
): Promise<boolean> {
  const text = event.message?.text?.trim().toLowerCase();

  if (event.type !== "message" || event.message?.type !== "text" || text !== "id" || !event.replyToken) {
    return false;
  }

  await sendLineReplyMessage(event.replyToken, [
    { type: "text", text: `Your user ID: ${lineUserId}` },
  ]);

  return true;
}

// Function ตรวจว่าคะแนนอยู่ในช่วงที่รองรับ
function isValidRatingScore(score: number | null): score is number {
  return (
    typeof score === "number" &&
    Number.isInteger(score) &&
    score >= MIN_RATING_SCORE &&
    score <= MAX_RATING_SCORE
  );
}

// Function ดึงยอด final_stall_amount ของ Ticket ที่ต้อง Financialize แล้วเท่านั้น
function requireFinalStallAmountBaht(ticket: BoothJobDto): number {
  if (ticket.final_stall_amount === null || ticket.financialized_at === null) {
    throw new ApiError(
      500,
      "TICKET_FINANCIAL_STATE_INVALID",
      "Completed ticket does not have finalized financial data."
    );
  }

  const amount = Number(ticket.final_stall_amount);

  if (!Number.isFinite(amount) || amount < 0) {
    throw new ApiError(
      500,
      "TICKET_FINAL_STALL_AMOUNT_INVALID",
      "Final stall amount is invalid."
    );
  }

  return amount;
}

// Function สร้างข้อความ LINE ผลการให้คะแนนของ Vendor
async function buildVendorRatingMessages(
  ticket: BoothJobDto,
  submissionId: number,
  detail: TicketJobDetailResponse | null
): Promise<LineMessage[]> {
  const ratingToken = await lineActionTokenRepository.createLineActionToken({
    action: "vendor_rate_ticket",
    ticket_id: ticket.id,
    submission_id: submissionId,
    boothCode: ticket.boothCode,
  });

  return [
    buildVendorRatingPromptFlexMessage({
      ticket,
      detail,
      ratingToken: ratingToken.token,
    }),
  ];
}

// Function สร้างข้อความ LINE แจ้งว่ารายการนี้ถูกดำเนินการไปแล้ว
function buildVendorDuplicateActionMessages(): LineMessage[] {
  return [
    {
      type: "text",
      text: "รายการนี้ได้รับการดำเนินการเรียบร้อยแล้ว",
    },
  ];
}

// Function ประมวลผล Vendor ให้คะแนนผ่าน LINE postback (คืน true เมื่อสำเร็จ)
async function handleVendorRateTicketPostback(
  tokenPayload: VendorTicketActionTokenPayload,
  lineUserId: string,
  score: number | null
): Promise<boolean> {
  if (!isValidRatingScore(score)) {
    return false;
  }

  const ratingResult = await withTransaction(async (transaction) => {
    const ticket = await boothJobRepository.findBoothJobForCompletion(
      tokenPayload.ticket_id,
      transaction
    );
    const vendorLineTargets = ticket
      ? await boothJobRepository.listActiveVendorLineTargetsForTicket(
        ticket.id,
        transaction
      )
      : [];
    const vendorLineTarget = vendorLineTargets.find(
      (target) => target.line_user_id === lineUserId
    );

    if (
      !ticket ||
      !vendorLineTarget ||
      ticket.boothCode !== tokenPayload.boothCode ||
      ticket.status !== TICKET_STATUS.COMPLETED
    ) {
      return null;
    }

    const submission = await boothJobRepository.findTicketCompletionSubmissionById(
      tokenPayload.submission_id,
      transaction
    );

    if (
      !submission ||
      submission.ticket_id !== ticket.id ||
      submission.status !== TICKET_STATUS.COMPLETED
    ) {
      return null;
    }

    const [rating, products, detail] = await Promise.all([
      lineRepository.upsertTicketRating(
        {
          ticket_id: ticket.id,
          submission_id: submission.id,
          line_user_id: lineUserId,
          target_type: vendorLineTarget.target_type,
          score,
        },
        transaction
      ),
      boothJobRepository.listTicketProducts(ticket.id, transaction),
      ticketJobRepository.getTicketJobDetail(
        ticket.vehicle_job_id,
        transaction
      ),
    ]);

    return {
      ticket,
      submission,
      rating,
      products,
      detail,
    };
  });

  if (!ratingResult) {
    return false;
  }

  // claim token ก่อนส่งข้อความ กัน LINE ส่ง event ซ้ำแล้วตอบซ้ำ
  const claimed = await lineRepository.claimLineActionTokenUsed(tokenPayload.id);

  if (!claimed) {
    return true;
  }

  const stallAmountBaht = requireFinalStallAmountBaht(ratingResult.ticket);

  await enqueueLoggedLineMessage({
    jobName: "send-vendor-ticket-rating-result",
    action: "send_vendor_ticket_rating_result",
    targetLineUserId: lineUserId,
    payload: {
      ticket_id: ratingResult.ticket.id,
      submission_id: ratingResult.submission.id,
      line_user_id: lineUserId,
      score: ratingResult.rating.score,
      final_stall_amount: ratingResult.ticket.final_stall_amount,
    },
    messages: buildVendorRatingResultFlexMessages({
      ticket: ratingResult.ticket,
      detail: ratingResult.detail,
      score: ratingResult.rating.score,
      stallAmountBaht,
    }),
  });

  publishRealtimeEvent({
    type: "TICKET_RATED",
    title: "Ticket rated",
    message: `Vendor rated ticket ${ratingResult.ticket.boothCode} ${ratingResult.rating.score}/5.`,
    payload: {
      ...buildWorkerTicketPayload(
        ratingResult.ticket,
        ratingResult.detail,
        ratingResult.products,
        {
          submission_status: ratingResult.submission.status,
          rating_score: ratingResult.rating.score,
          line_target_type: ratingResult.rating.target_type,
        }
      ),
    },
    admin: true,
  });

  return true;
}

// Function ประมวลผล Vendor ยืนยัน/ตีกลับยอดผ่าน LINE postback (คืน true เมื่อประมวลผลแล้ว)
async function handleVendorCompletionDecisionPostback(
  tokenPayload: VendorTicketActionTokenPayload,
  lineUserId: string,
  resolvedAction: "vendor_confirm_completion" | "vendor_reject_completion",
  rejectReason: string | null
): Promise<boolean> {
  const result = await withTransaction(async (transaction) => {
    const ticket = await boothJobRepository.findBoothJobForCompletion(
      tokenPayload.ticket_id,
      transaction
    );
    const vendorLineTargets = ticket
      ? await boothJobRepository.listActiveVendorLineTargetsForTicket(
        ticket.id,
        transaction
      )
      : [];
    const vendorLineTarget = vendorLineTargets.find(
      (target) => target.line_user_id === lineUserId
    );

    if (
      !ticket ||
      !vendorLineTarget ||
      ticket.boothCode !== tokenPayload.boothCode
    ) {
      return null;
    }

    const submission = await boothJobRepository.findWaitingTicketCompletionSubmission(
      ticket.id,
      transaction
    );

    if (!submission || submission.id !== tokenPayload.submission_id) {
      const tokenSubmission =
        await boothJobRepository.findTicketCompletionSubmissionById(
          tokenPayload.submission_id,
          transaction
        );

      if (
        tokenSubmission &&
        tokenSubmission.ticket_id === ticket.id &&
        ([TICKET_STATUS.COMPLETED, TICKET_STATUS.REJECT] as string[]).includes(tokenSubmission.status)
      ) {
        const detail = await ticketJobRepository.getTicketJobDetail(
          ticket.vehicle_job_id,
          transaction
        );

        return {
          kind: "already_handled" as const,
          ticket,
          submission: tokenSubmission,
          detail,
          vendorLineTarget,
        };
      }

      return null;
    }

    const completionResult = await applyVendorTicketCompletionResult({
      ticket,
      submission,
      action: resolvedAction === "vendor_confirm_completion" ? "confirm" : "reject",
      rejectReason,
      resolvedByLineUserId: lineUserId,
      connection: transaction,
    });

    return {
      kind: "processed" as const,
      ...completionResult,
      vendorLineTarget,
    };
  });

  if (!result) {
    return false;
  }

  if (result.kind === "already_handled") {
    await enqueueLoggedLineMessage({
      jobName: "send-vendor-ticket-already-handled",
      action: "send_vendor_ticket_already_handled",
      targetLineUserId: lineUserId,
      payload: {
        ticket_id: result.ticket.id,
        submission_id: result.submission.id,
        status: result.submission.status,
        line_user_id: lineUserId,
        previous_line_user_id: result.submission.resolved_by_line_user_id,
      },
      messages: buildVendorDuplicateActionMessages(),
    });
    return true;
  }

  // แจ้ง Driver Web หลัง commit
  publishDriverJobUpdate(
    result.ticket.vehicle_job_id,
    result.completedTicketJob ? "DRIVER_JOB_TERMINAL" : "DRIVER_JOB_UPDATED",
  );

  await removeVendorConfirmationTimeout(result.ticket.id, result.submission.id);
  await returnCompletedWorkersToQueue(result.completedTicketJob);

  await enqueueLoggedLineMessage({
    jobName: "send-vendor-ticket-completion-result",
    action: "send_vendor_ticket_completion_result",
    targetLineUserId: lineUserId,
    payload: {
      ticket_id: result.ticket.id,
      submission_id: result.submission.id,
      status: result.submission.status,
      reject_reason: result.ticket.reject_reason,
    },
    messages: [
      buildVendorCompletionResultFlexMessage({
        ticket: result.ticket,
        detail: result.detail,
        isConfirmed: result.isConfirmed,
      }),
    ],
  });

  if (result.isConfirmed) {
    const ratingMessages = await buildVendorRatingMessages(
      result.ticket,
      result.submission.id,
      result.detail
    );
    await enqueueLoggedLineMessage({
      jobName: "send-vendor-ticket-rating-prompt",
      action: "send_vendor_ticket_rating_prompt",
      targetLineUserId: lineUserId,
      payload: {
        ticket_id: result.ticket.id,
        submission_id: result.submission.id,
        line_user_id: lineUserId,
        line_target_type: result.vendorLineTarget.target_type,
      },
      messages: ratingMessages,
    });
  }

  const realtimePayload = {
    ...buildWorkerTicketPayload(
      result.ticket,
      result.detail,
      result.products,
      buildTicketCompletionResultExtraFields(result)
    ),
  };

  publishTicketCompletionResultEvent(result, {
    title: result.title,
    message: result.message,
    payload: realtimePayload,
  });

  return true;
}

// Function รับ LINE webhook แล้วประมวลผลทีละ event
export async function handleLineWebhook(
  body: unknown,
  signature?: unknown,
  rawBody?: string
): Promise<{
  message: string;
  processed: number;
}> {
  verifyLineSignature(rawBody, signature);

  const events = Array.isArray((body as { events?: unknown }).events)
    ? ((body as { events: LineWebhookEvent[] }).events)
    : [];
  let processed = 0;

  for (const event of events) {
    // แยก try/catch ต่อ event ไม่ให้ event หนึ่งล้มแล้วกระทบ event อื่น
    let lineUserId: string | null = null;
    let tokenPayload: Awaited<ReturnType<typeof verifyLineActionToken>> = null;

    try {
      const { action, token, rejectReason, score } = parseLinePostback(event.postback?.data);
      lineUserId = getLineUserId(event);

      if (lineUserId && (await handleGetUserIdTextMessage(event, lineUserId))) {
        processed += 1;
        continue;
      }

      if (
        event.type !== "postback" ||
        !lineUserId ||
        !token
      ) {
        continue;
      }

      tokenPayload = await verifyLineActionToken(token, action ?? undefined);
      const resolvedAction = action ?? tokenPayload?.action ?? null;

      if (!tokenPayload || !resolvedAction) {
        continue;
      }

      // copy เป็น const เพื่อให้ TypeScript narrow type ใน closure
      const verifiedTokenPayload = tokenPayload;
      const verifiedLineUserId = lineUserId;

      if (resolvedAction === "vendor_rate_ticket") {
        if (await handleVendorRateTicketPostback(verifiedTokenPayload, verifiedLineUserId, score)) {
          processed += 1;
        }
        continue;
      }

      if (
        resolvedAction !== "vendor_confirm_completion" &&
        resolvedAction !== "vendor_reject_completion"
      ) {
        continue;
      }

      if (
        await handleVendorCompletionDecisionPostback(
          verifiedTokenPayload,
          verifiedLineUserId,
          resolvedAction,
          rejectReason
        )
      ) {
        processed += 1;
      }
    } catch (error) {
      if (error instanceof TicketSubmissionAlreadyResolvedError && lineUserId && tokenPayload) {
        // timeout job ยืนยันไปก่อนแล้ว ตอบ already_handled กลับ Vendor
        await enqueueLoggedLineMessage({
          jobName: "send-vendor-ticket-already-handled",
          action: "send_vendor_ticket_already_handled",
          targetLineUserId: lineUserId,
          payload: {
            ticket_id: tokenPayload.ticket_id,
            submission_id: tokenPayload.submission_id,
            line_user_id: lineUserId,
          },
          messages: buildVendorDuplicateActionMessages(),
        });
        processed += 1;
        continue;
      }

      logger.error("Failed to process LINE webhook event.", { error });
    }
  }

  return {
    message: "LINE webhook processed.",
    processed,
  };
}
