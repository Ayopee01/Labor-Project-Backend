import { VEHICLE_JOB_STATUS } from "../constants/status";
import type { VendorTicketCompletionFlowResult } from "../types/line.type";
import type { BoothJobDto, TicketProductDto, TicketJobDetailResponse } from "../types/worker.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function จัดรูปแบบ worker ticket items สำหรับ helper กลาง
function formatWorkerTicketItems(products: TicketProductDto[]) {
  return products.map((product) => ({
    productCode: product.productCode,
    productName: product.productName,
    packageCode: product.packageCode,
    packageName: product.packageName,
    quantity: product.quantity,
    confirmed_quantity: product.confirmed_quantity,
  }));
}

// Function ค้นหา Business Ticket (market) ที่ ticket/booth นี้สังกัดอยู่ สำหรับ helper กลาง
export function findTicketMarket(
  detail: TicketJobDetailResponse | null,
  ticket: BoothJobDto
): TicketJobDetailResponse["markets"][number] | null {
  return detail?.markets.find((market) =>
    market.booths.some((booth) => booth.boothCode === ticket.boothCode)
  ) ?? null;
}

// Function สร้าง worker ticket payload สำหรับ helper กลาง
export function buildWorkerTicketPayload(
  ticket: BoothJobDto,
  detail: TicketJobDetailResponse | null,
  products: TicketProductDto[],
  extra: Record<string, unknown> = {}
) {
  const market = findTicketMarket(detail, ticket);

  return {
    ticket_number: detail?.vehicle_job.ticket_number ?? null,
    ticket_no: market?.ticket_no ?? null,
    // Format ticketNos keeps push event payloads consistent
    ticketNos: market?.ticket_no ? [market.ticket_no] : [],
    ticket_completed_at:
      detail?.vehicle_job.status === VEHICLE_JOB_STATUS.COMPLETED
        ? detail.vehicle_job.updated_at
        : null,
    marketCode: market?.marketCode ?? null,
    marketName: market?.marketName ?? null,
    boothCode: ticket.boothCode,
    boothName: ticket.boothName,
    status: ticket.status,
    confirmation_status: ticket.confirmation_status,
    completed_at: ticket.completed_at,
    ...extra,
    items: formatWorkerTicketItems(products),
  };
}

// Function สร้าง extra fields ของผล confirm/reject ticket completion สำหรับส่งเข้า
// buildWorkerTicketPayload — ใช้ร่วมกันทุกจุดที่แจ้งผลนี้ (auto-timeout, LINE webhook, LINE dev tester)
export function buildTicketCompletionResultExtraFields(
  result: VendorTicketCompletionFlowResult,
  reason?: string
): Record<string, unknown> {
  return {
    submission_status: result.submission.status,
    confirmed_at: result.submission.confirmed_at,
    rejected_at: result.submission.rejected_at,
    vehicle_job_status: result.completedTicketJob?.vehicle_job.status,
    completed_worker_codes: result.completedWorkerCodes,
    ticket_completed_at: result.completedTicketJob?.vehicle_job.updated_at ?? null,
    nextMarketCode: result.nextTicket?.marketCode ?? null,
    nextBoothCode: result.nextTicket?.ticket.boothCode ?? null,
    next_ticket_status: result.nextTicket?.ticket.status ?? null,
    assignment_status: result.assignmentStatus,
    ...(reason !== undefined ? { reason } : {}),
  };
}
