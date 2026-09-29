// Import Types
import type { TicketJobAssignmentDto, TicketJobDto, VehicleWorkReadinessDto, WorkerQueueEntryDto } from "../types/worker.type";
// Import Utils
import { resolveWorkerWorkStatus } from "./worker-status";
import { toUnixMs } from "./time";

/* -------------------------------------- Functions -------------------------------------- */

// Function สร้าง payload งานที่มอบหมายให้ worker พร้อม TicketNo ที่ยัง active และเวลาสร้าง
export function buildWorkerAssignedPayload(
  assignment: TicketJobAssignmentDto,
  ticketJob: TicketJobDto,
  tickets: Array<{ ticket_no: string; created_at: string }>
) {
  return {
    ticketNumber: ticketJob.ticket_number,
    ticketNos: tickets.map((ticket) => ticket.ticket_no),
    tickets,
    accept_created_at: assignment.created_at,
    assignment: {
      accept_deadline_at: assignment.accept_deadline_at,
      accept_deadline_unix_ms: toUnixMs(assignment.accept_deadline_at),
    },
  };
}

// Function สร้าง payload สถานะคิวของ worker สำหรับส่งทาง socket
export function buildWorkerQueueSocketPayload(
  queueEntry: WorkerQueueEntryDto | null | undefined,
  workerCode: string | null,
  assignment: TicketJobAssignmentDto | null = null,
  teamScanReadiness?: Pick<VehicleWorkReadinessDto, "is_ready"> | null
) {
  if (!queueEntry) {
    return null;
  }

  return {
    worker_code: workerCode,
    status: resolveWorkerWorkStatus(queueEntry, assignment, teamScanReadiness),
    ...(queueEntry.ready_at ? { ready_at: queueEntry.ready_at } : {}),
    ...(queueEntry.break_until
      ? {
        break_until: queueEntry.break_until,
        break_until_unix_ms: toUnixMs(queueEntry.break_until),
      }
      : {}),
    created_at: queueEntry.created_at,
    updated_at: queueEntry.updated_at,
    ...(queueEntry.break_count_used !== undefined
      ? { break_count_used: queueEntry.break_count_used }
      : {}),
    ...(queueEntry.break_count_limit !== undefined
      ? { break_count_limit: queueEntry.break_count_limit }
      : {}),
    ...(queueEntry.break_duration_minutes !== undefined
      ? { break_duration_minutes: queueEntry.break_duration_minutes }
      : {}),
  };
}
