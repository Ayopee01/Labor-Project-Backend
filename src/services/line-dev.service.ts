// Import Library
import { z } from "zod";
// Import Config
import { withTransaction } from "../db/prisma";
// Import Queues
import { returnCompletedWorkersToQueue } from "../queues/worker-dispatch";
import { removeVendorConfirmationTimeout } from "../queues/worker-queue";
// Import Repositories
import * as lineRepository from "../repositories/line.repository";
import * as boothJobRepository from "../repositories/shared/booth-job.repository";
// Import Config
import { TICKET_STATUS } from "../constants/status";
// Import Types
import type { LineDevCompletionResult, LineDevSubmissionItem, VendorTicketCompletionAction } from "../types/line.type";
// Import Utils
import ApiError from "../utils/api-error";
import { buildTicketCompletionResultExtraFields, buildWorkerTicketPayload } from "../utils/ticket-payload";
// Import Validation
import { parseId, parseWithSchema } from "../validation/parser";
// Import Services
import { applyVendorTicketCompletionResult } from "./shared/ticket-completion.service";
import { publishRealtimeEvent } from "./shared/realtime-notification.service";

const LINE_DEV_RESOLVER_ID = "line-dev-tester";
const lineDevRejectBodySchema = z.object({
  reject_reason: z.string().trim().max(1000).optional(),
});

// Function ดึง Submission ทั้งหมดสำหรับหน้า LINE dev tester
export async function listLineDevSubmissions(): Promise<{
  data: LineDevSubmissionItem[];
}> {
  return {
    data: await lineRepository.listLineDevSubmissions(),
  };
}

// Function ยืนยันหรือปฏิเสธ Submission จากหน้า LINE dev โดยใช้ completion flow เดียวกับ LINE จริง
// แต่จงใจไม่ enqueue ข้อความ LINE เพื่อไม่ใช้ Messaging API quota
export async function processLineDevSubmission(
  submissionIdParam: unknown,
  action: VendorTicketCompletionAction,
  body: unknown = {},
): Promise<LineDevCompletionResult> {
  const submissionId = parseId(submissionIdParam);
  const rejectInput = parseWithSchema(lineDevRejectBodySchema, body ?? {});

  const result = await withTransaction(async (transaction) => {
    const submission =
      await boothJobRepository.findTicketCompletionSubmissionById(
        submissionId,
        transaction,
      );

    if (!submission) {
      throw new ApiError(
        404,
        "SUBMISSION_NOT_FOUND",
        "Ticket completion submission was not found.",
      );
    }

    const ticket = await boothJobRepository.findBoothJobForCompletion(
      submission.ticket_id,
      transaction,
    );
    const waitingSubmission = ticket
      ? await boothJobRepository.findWaitingTicketCompletionSubmission(
          ticket.id,
          transaction,
        )
      : null;

    if (
      !ticket ||
      ticket.status !== TICKET_STATUS.DELIVERED ||
      submission.status !== TICKET_STATUS.DELIVERED ||
      waitingSubmission?.id !== submission.id
    ) {
      throw new ApiError(
        409,
        "SUBMISSION_ALREADY_HANDLED",
        "This submission has already been confirmed, rejected, or superseded.",
      );
    }

    return applyVendorTicketCompletionResult({
      ticket,
      submission,
      action,
      rejectReason:
        action === "reject" ? rejectInput.reject_reason ?? null : null,
      resolvedByLineUserId: LINE_DEV_RESOLVER_ID,
      connection: transaction,
    });
  });

  await removeVendorConfirmationTimeout(result.ticket.id, result.submission.id);
  await returnCompletedWorkersToQueue(result.completedTicketJob);

  const realtimePayload = buildWorkerTicketPayload(
    result.ticket,
    result.detail,
    result.products,
    buildTicketCompletionResultExtraFields(result, "line_dev_tester")
  );

  publishRealtimeEvent({
    type: "TICKET_COMPLETION_RESULT",
    title: result.title,
    message: `${result.message} (LINE dev tester)`,
    payload: realtimePayload,
    worker_payload: realtimePayload,
    admin: true,
    worker_ids: result.receiverAccountIds,
  });

  return {
    message:
      action === "confirm"
        ? "Confirmed from LINE dev tester without sending a LINE message."
        : "Rejected from LINE dev tester without sending a LINE message.",
    submission_id: result.submission.id,
    ticket_id: result.ticket.id,
    boothCode: result.ticket.boothCode,
    ticket_status: result.ticket.status,
    submission_status: result.submission.status,
    action,
    vehicle_job_status: result.completedTicketJob?.vehicle_job.status ?? null,
  };
}
