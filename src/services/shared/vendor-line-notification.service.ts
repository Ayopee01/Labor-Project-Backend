// Import Queues
import { enqueueLoggedLineMessage } from "../../queues/line-message-queue";
// Import Repositories
import * as boothJobRepository from "../../repositories/shared/booth-job.repository";
// Import Utils
import { logger } from "../../utils/logger";
import { buildBoothJobCancelledFlexMessage, buildBoothJobDispatchResumedFlexMessage, buildBoothJobWaitFlexMessage } from "../../utils/line-flex-message";

/* -------------------------------------- Types -------------------------------------- */

// Type ข้อมูลแผงหนึ่งใบที่ต้องใช้แจ้ง LINE ยกเลิก/รอลง/เริ่มจัดทีมใหม่ — ใช้ร่วมกันทุก notify function ในไฟล์นี้
type VendorBoothNotificationInput = {
  ticketId: number;
  ticketNo: string;
  marketName: string;
  boothCode: string;
  boothName: string | null;
  licensePlate: string;
};

/* -------------------------------------- Functions -------------------------------------- */

// Function แจ้ง LINE แผงว่างานถูกยกเลิก — best-effort เท่านั้น ห้าม throw กัน request cancel ที่สำเร็จแล้วพัง 500 เพราะแจ้งเตือนล้มเหลว
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

// Function แจ้ง LINE แผงว่าทีมงานถูกดึงกลับเข้าคิว รองานใหม่ (รถถูกสั่งกลับไป "รอลง") — best-effort เท่านั้น เหตุผลเดียวกับ notifyVendorBoothCancelled
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

// Function แจ้ง LINE แผงว่าทีมงานถูกจัดส่งอีกครั้ง (รถถูกสั่งกลับจาก "รอลง" เป็น "ลงเลย" ไม่ว่าจะโดย Admin หรือ Driver กด Ready) — best-effort เท่านั้น เหตุผลเดียวกับ notifyVendorBoothCancelled
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
