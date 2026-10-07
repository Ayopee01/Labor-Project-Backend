// Import Repositories
import * as boothJobRepository from "../../repositories/shared/booth-job.repository";
import * as lineActionTokenRepository from "../../repositories/shared/line-action-token.repository";
// Import Queues
import { enqueueLoggedLineMessage } from "../../queues/line-message-queue";
// Import Types
import type { BoothJobDto, TicketJobDetailResponse } from "../../types/worker.type";
// Import Utils
import { logger } from "../../utils/logger";
import { buildBoothJobCancelledFlexMessage, buildBoothJobDispatchResumedFlexMessage, buildBoothJobWaitFlexMessage, buildVendorCompletionResultFlexMessage, buildVendorRatingPromptFlexMessage } from "../../utils/line-flex-message";

/* -------------------------------------- Types -------------------------------------- */

// Type ข้อมูลแผงที่ใช้แจ้ง LINE (ยกเลิก/รอลง/เริ่มจัดทีมใหม่)
type VendorBoothNotificationInput = {
  ticketId: number;
  ticketNo: string;
  marketName: string;
  boothCode: string;
  boothName: string | null;
  licensePlate: string;
};

/* -------------------------------------- Functions -------------------------------------- */

// Function แจ้ง LINE แผงว่างานถูกยกเลิก (best-effort ไม่ throw)
export async function notifyVendorBoothCancelled(
  input: VendorBoothNotificationInput,
): Promise<void> {
  try {
    const targets = await boothJobRepository.listActiveVendorLineTargetsForTicket(
      input.ticketId,
    );

    if (targets.length === 0) {
      return;
    }

    const message = buildBoothJobCancelledFlexMessage({
      ticketNo: input.ticketNo,
      marketName: input.marketName,
      boothCode: input.boothCode,
      boothName: input.boothName,
      licensePlate: input.licensePlate,
    });

    for (const target of targets) {
      await enqueueLoggedLineMessage({
        jobName: "send-gate-ticket-cancelled",
        action: "send_gate_ticket_cancelled",
        targetLineUserId: target.line_user_id,
        payload: {
          ticketNo: input.ticketNo,
          boothCode: input.boothCode,
          vendor_line_id: target.line_user_id,
          vendor_line_target_type: target.target_type,
        },
        messages: [message],
      });
    }
  } catch (error) {
    logger.error("Failed to notify vendor LINE about stall job cancellation.", {
      ticketId: input.ticketId,
      boothCode: input.boothCode,
      error,
    });
  }
}

// Function แจ้ง LINE แผงว่ารถถูกสั่งกลับไป "รอลง" (best-effort ไม่ throw)
export async function notifyVendorBoothWait(
  input: VendorBoothNotificationInput,
): Promise<void> {
  try {
    const targets = await boothJobRepository.listActiveVendorLineTargetsForTicket(
      input.ticketId,
    );

    if (targets.length === 0) {
      return;
    }

    const message = buildBoothJobWaitFlexMessage({
      ticketNo: input.ticketNo,
      marketName: input.marketName,
      boothCode: input.boothCode,
      boothName: input.boothName,
      licensePlate: input.licensePlate,
    });

    for (const target of targets) {
      await enqueueLoggedLineMessage({
        jobName: "send-gate-ticket-wait",
        action: "send_gate_ticket_wait",
        targetLineUserId: target.line_user_id,
        payload: {
          ticketNo: input.ticketNo,
          boothCode: input.boothCode,
          vendor_line_id: target.line_user_id,
          vendor_line_target_type: target.target_type,
        },
        messages: [message],
      });
    }
  } catch (error) {
    logger.error("Failed to notify vendor LINE about vehicle job set to wait.", {
      ticketId: input.ticketId,
      boothCode: input.boothCode,
      error,
    });
  }
}

// Function แจ้ง LINE แผงว่ารถกลับมา "ลงเลย" และเริ่มจัดทีมอีกครั้ง (best-effort ไม่ throw)
export async function notifyVendorBoothDispatchResumed(
  input: VendorBoothNotificationInput,
): Promise<void> {
  try {
    const targets = await boothJobRepository.listActiveVendorLineTargetsForTicket(
      input.ticketId,
    );

    if (targets.length === 0) {
      return;
    }

    const message = buildBoothJobDispatchResumedFlexMessage({
      ticketNo: input.ticketNo,
      marketName: input.marketName,
      boothCode: input.boothCode,
      boothName: input.boothName,
      licensePlate: input.licensePlate,
    });

    for (const target of targets) {
      await enqueueLoggedLineMessage({
        jobName: "send-gate-ticket-dispatch-resumed",
        action: "send_gate_ticket_dispatch_resumed",
        targetLineUserId: target.line_user_id,
        payload: {
          ticketNo: input.ticketNo,
          boothCode: input.boothCode,
          vendor_line_id: target.line_user_id,
          vendor_line_target_type: target.target_type,
        },
        messages: [message],
      });
    }
  } catch (error) {
    logger.error("Failed to notify vendor LINE about vehicle job dispatch resumed.", {
      ticketId: input.ticketId,
      boothCode: input.boothCode,
      error,
    });
  }
}

// Function แจ้ง LINE ทุกคนในแผงว่าระบบยืนยันยอดอัตโนมัติ (timeout) พร้อมปุ่มให้คะแนน (best-effort ไม่ throw)
export async function notifyVendorTicketAutoConfirmed(input: {
  ticket: BoothJobDto;
  submissionId: number;
  detail: TicketJobDetailResponse | null;
}): Promise<void> {
  try {
    const targets = await boothJobRepository.listActiveVendorLineTargetsForTicket(
      input.ticket.id,
    );
    const completionMessage = buildVendorCompletionResultFlexMessage({
      ticket: input.ticket,
      detail: input.detail,
      isConfirmed: true,
      isAutoConfirmed: true,
    });

    for (const target of targets) {
      await enqueueLoggedLineMessage({
        jobName: "send-vendor-ticket-completion-result",
        action: "send_vendor_ticket_completion_result",
        targetLineUserId: target.line_user_id,
        payload: {
          ticket_id: input.ticket.id,
          submission_id: input.submissionId,
          status: input.ticket.status,
          auto_confirmed: true,
          line_user_id: target.line_user_id,
        },
        messages: [completionMessage],
      });

      // token ให้คะแนนแยกรายคน คะแนนของแผงนับจากคนแรกที่กด
      const ratingToken = await lineActionTokenRepository.createLineActionToken({
        action: "vendor_rate_ticket",
        ticket_id: input.ticket.id,
        submission_id: input.submissionId,
        boothCode: input.ticket.boothCode,
      });

      await enqueueLoggedLineMessage({
        jobName: "send-vendor-ticket-rating-prompt",
        action: "send_vendor_ticket_rating_prompt",
        targetLineUserId: target.line_user_id,
        payload: {
          ticket_id: input.ticket.id,
          submission_id: input.submissionId,
          line_user_id: target.line_user_id,
          line_target_type: target.target_type,
        },
        messages: [
          buildVendorRatingPromptFlexMessage({
            ticket: input.ticket,
            detail: input.detail,
            ratingToken: ratingToken.token,
          }),
        ],
      });
    }
  } catch (error) {
    logger.error("Failed to notify vendor LINE about auto-confirmed ticket.", {
      ticketId: input.ticket.id,
      submissionId: input.submissionId,
      error,
    });
  }
}
