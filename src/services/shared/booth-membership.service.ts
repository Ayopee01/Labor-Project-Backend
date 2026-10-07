// Import Library
import { Prisma } from "@prisma/client";
// Import Config
import { TICKET_STATUS, TICKET_WORKER_STATUS } from "../../constants/status";
// Import Types
import type { BoothMembershipRecord } from "../../types/shared/booth-membership.type";
// Import Utils
import { calculateProductWorkerPayment } from "../../utils/labor-job-pricing";

/* -------------------------------------- Config -------------------------------------- */

// Config สถานะแผงที่มีรายชื่อคนได้เงินจากการส่งยอดแล้ว (Admin เลือกให้เงิน/ไม่ให้เงินรายแผงได้)
export const PAYOUT_SNAPSHOT_BOOTH_STATUSES: string[] = [
  TICKET_STATUS.DELIVERED,
  TICKET_STATUS.REJECT,
  TICKET_STATUS.COMPLETED,
];

// Config สถานะแผงที่ต้องเหลือคนได้เงินอย่างน้อย 1 คน (ยกเลิกแผงไม่ได้แล้ว)
export const MIN_ONE_WORKER_BOOTH_STATUSES: string[] = [
  TICKET_STATUS.DELIVERED,
  TICKET_STATUS.COMPLETED,
];

/* -------------------------------------- Functions -------------------------------------- */

// Function หา ticket_worker_id ที่เป็นสมาชิกของแผงตามสถานะแผง ลบคนที่ถูกถอดออกจากแผง
export function resolveBoothMemberTicketWorkerIds(booth: BoothMembershipRecord): number[] {
  // ยังไม่ส่งยอด = roster WORKING, รอ Vendor/ตีกลับ = รายชื่อตอนส่ง, ยืนยันแล้ว = snapshot ตอนยืนยัน
  const excludedIds = new Set(booth.excluded_ticket_worker_ids);
  const workingRoster = booth.roster.filter((member) => member.status === TICKET_WORKER_STATUS.WORKING);
  let baseIds = workingRoster.map((member) => member.ticket_worker_id);

  if (booth.status === TICKET_STATUS.COMPLETED) {
    baseIds = booth.booth_snapshot_ticket_worker_ids;
  } else if (PAYOUT_SNAPSHOT_BOOTH_STATUSES.includes(booth.status)) {
    baseIds = booth.latest_submission?.snapshot_ticket_worker_ids ?? [];
  }

  // แผงที่ถูกตีกลับ เพิ่มคนที่ Admin เลือกเข้าแผงและ scan แล้ว (จึงมี roster)
  if (booth.status === TICKET_STATUS.REJECT) {
    const includedWorkerIds = new Set(booth.included_worker_ids);

    baseIds = [
      ...baseIds,
      ...workingRoster
        .filter((member) => includedWorkerIds.has(member.worker_id))
        .map((member) => member.ticket_worker_id),
    ];
  }

  return [...new Set(baseIds)].filter((id) => !excludedIds.has(id));
}

// Function ตรวจว่า worker บนรถที่ยังไม่ scan จะเป็นสมาชิกของแผงนี้หรือไม่ (แผงต้องรอ scan ก่อนส่งยอด)
export function isPendingBoothMember(booth: BoothMembershipRecord, workerId: number): boolean {
  // แผงที่ถูกตีกลับรอเฉพาะคนที่ Admin เลือกเข้าแผง ส่วนแผงที่ยังไม่ส่งยอดรอทุกคนที่ไม่ถูกถอดจากแผง
  if (booth.status === TICKET_STATUS.REJECT) {
    return booth.included_worker_ids.includes(workerId);
  }

  const rosterMember = booth.roster.find((member) => member.worker_id === workerId);

  if (!rosterMember) {
    return true;
  }

  return (
    rosterMember.status === TICKET_WORKER_STATUS.WORKING &&
    !booth.excluded_ticket_worker_ids.includes(rosterMember.ticket_worker_id)
  );
}

// Function หา ticket_worker_id ของ worker ใน Business Ticket ของแผง (ไม่มีคืน null)
export function findBoothTicketWorkerId(
  booth: BoothMembershipRecord,
  workerId: number
): number | null {
  return booth.roster.find((member) => member.worker_id === workerId)?.ticket_worker_id ?? null;
}

// Function หาเงินของ worker ในแผงที่ยืนยันแล้ว (ปิดยอดแล้วใช้ยอดจริง ยังไม่ปิดคิดจากสูตรเดียวกัน) แผงที่ยังไม่ยืนยันคืน null
export function estimateBoothWorkerAmount(
  booth: BoothMembershipRecord,
  ticketWorkerId: number
): Prisma.Decimal | null {
  if (booth.status !== TICKET_STATUS.COMPLETED) {
    return null;
  }

  const memberIds = resolveBoothMemberTicketWorkerIds(booth);

  return booth.products.reduce((total, product) => {
    if (product.payments) {
      const payment = product.payments.find((item) => item.ticket_worker_id === ticketWorkerId);

      return total.plus(payment?.final_amount ?? 0);
    }

    if (product.labor_fee_raw === null || !memberIds.includes(ticketWorkerId)) {
      return total;
    }

    return total.plus(
      calculateProductWorkerPayment({
        laborFeeRaw: new Prisma.Decimal(product.labor_fee_raw),
        actualWorkerCount: memberIds.length,
      }).finalAmountPerWorker
    );
  }, new Prisma.Decimal(0));
}

// Function นับที่นั่งของแผง = สมาชิกปัจจุบัน + คนที่ Admin เลือกเข้าแผงแต่ยังไม่ scan (ใช้เทียบเพดาน workers_required)
export function countBoothSeats(booth: BoothMembershipRecord): number {
  const memberIds = resolveBoothMemberTicketWorkerIds(booth);
  const memberWorkerIds = new Set(
    booth.roster
      .filter((member) => memberIds.includes(member.ticket_worker_id))
      .map((member) => member.worker_id)
  );
  const pendingIncludedCount = booth.included_worker_ids.filter(
    (workerId) => !memberWorkerIds.has(workerId)
  ).length;

  return memberIds.length + pendingIncludedCount;
}
