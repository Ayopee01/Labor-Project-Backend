// Import Library
import { z } from "zod";
// Import Config
import { withTransaction } from "../db/prisma";
import { TICKET_STATUS } from "../constants/status";
// Import Repositories
import * as lineRepository from "../repositories/line.repository";
import * as boothJobRepository from "../repositories/shared/booth-job.repository";
import * as masterDataRepository from "../repositories/shared/master-data.repository";
// Import Services
import { applyVendorTicketCompletionResult } from "./shared/ticket-completion.service";
import { publishRealtimeEvent } from "./shared/realtime-notification.service";
import { publishDriverJobUpdate } from "./driver-stream.service";
// Import Queues
import { returnCompletedWorkersToQueue } from "../queues/worker-dispatch";
import { removeVendorConfirmationTimeout } from "../queues/worker-queue";
// Import Types
import type { LineDevAddMemberStallResult, LineDevCompletionResult, LineDevSubmissionItem, VendorTicketCompletionAction } from "../types/line.type";
// Import Validation
import { parseId, parseWithSchema } from "../validation/parser";
// Import Utils
import ApiError from "../utils/api-error";
import { buildTicketCompletionResultExtraFields, buildWorkerTicketPayload } from "../utils/ticket-payload";

/* -------------------------------------- Config -------------------------------------- */

// Config ชื่อผู้ยืนยันที่บันทึกเมื่อกดจากหน้า LINE dev tester
const LINE_DEV_RESOLVER_ID = "line-dev-tester";

// Schema body สำหรับปฏิเสธ submission จากหน้า LINE dev tester
const lineDevRejectBodySchema = z.object({
  reject_reason: z.string().trim().max(1000).optional(),
});
// Schema body สำหรับเพิ่ม test member stall
const lineDevAddMemberStallBodySchema = z.object({
  member_stall_line_user_id: z.string().trim().min(1),
  member_stall_first_name: z.string().trim().max(255).optional(),
  member_stall_last_name: z.string().trim().max(255).optional(),
  member_stall_id_card: z.string().trim().max(50).optional(),
  member_stall_telephone: z.string().trim().max(50).optional(),
  member_stall_user_group: z.string().trim().max(50).optional(),
});

/* -------------------------------------- Functions -------------------------------------- */

// Function ดึง Submission ทั้งหมดสำหรับหน้า LINE dev tester
export async function listLineDevSubmissions(): Promise<{
  data: LineDevSubmissionItem[];
}> {
  return {
    data: await lineRepository.listLineDevSubmissions(),
  };
}

// Function ยืนยัน/ปฏิเสธ Submission จากหน้า LINE dev ด้วย flow เดียวกับ LINE จริง (ไม่ส่งข้อความ LINE)
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

  publishDriverJobUpdate(
    result.ticket.vehicle_job_id,
    result.completedTicketJob ? "DRIVER_JOB_TERMINAL" : "DRIVER_JOB_UPDATED",
  );

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

// Function เพิ่ม test member ให้ผูกกับทุกเจ้าของแผงที่ active เพื่อรับแจ้งเตือน LINE ตอนทดสอบ
export async function addTestMemberStallToAllActiveOwners(
  body: unknown,
): Promise<LineDevAddMemberStallResult> {
  const input = parseWithSchema(lineDevAddMemberStallBodySchema, body ?? {});

  const { ownerStallCount } =
    await masterDataRepository.upsertTestMemberStallAcrossActiveOwners({
      memberStallLineUserId: input.member_stall_line_user_id,
      memberStallFirstName: input.member_stall_first_name,
      memberStallLastName: input.member_stall_last_name,
      memberStallIdCard: input.member_stall_id_card,
      memberStallTelephone: input.member_stall_telephone,
      memberStallUserGroup: input.member_stall_user_group,
    });

  return {
    member_stall_line_user_id: input.member_stall_line_user_id,
    owner_stall_count: ownerStallCount,
  };
}
