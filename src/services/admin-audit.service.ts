// Import Repositories
import * as adminAuditRepository from "../repositories/admin-audit.repository";
// Import Validation
import { parseWithSchema } from "../validation/parser";
import { adminAuditEventsQuerySchema, adminAuditWorkerPerformanceQuerySchema } from "../validation/schemas";
// Import Utils
import { buildBangkokDateRange, buildBangkokDateSpanRange, formatBangkokDate } from "../utils/time";
// Import Types
import { ADMIN_ACTION_TYPE } from "../types/shared/admin-action-log.type";
import { WORKER_ASSIGNMENT_EVENT_TYPE } from "../types/shared/worker-assignment-event.type";
import type { AdminActionLogDto } from "../types/shared/admin-action-log.type";
import type { AdminAuditActionLogRow, AdminAuditCompletionSubmissionRow, AdminAuditDriverSessionRow, AdminAuditEventItem, AdminAuditEventsQuery, AdminAuditEventsResponse, AdminAuditGateRequestLogRow, AdminAuditMessageDeliveryLogRow, AdminAuditTicketRatingRow, AdminAuditTicketJobRow, AdminAuditWorkerAssignmentEventRow, AdminAuditWorkerPerformanceQuery, AdminAuditWorkerPerformanceResponse } from "../types/admin-audit.type";
// Import Repositories
import type { AdminAuditDateRange } from "../repositories/admin-audit.repository";
// Import Types
import type { SecurityAuditLogDto } from "../types/shared/security-audit-log.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function ดึงสรุปผลงาน Worker ตามช่วงวันที่ พร้อม pagination
export async function listWorkerPerformance(
  query: unknown,
): Promise<AdminAuditWorkerPerformanceResponse> {
  const filters = parseWithSchema(
    adminAuditWorkerPerformanceQuerySchema,
    query,
  ) as AdminAuditWorkerPerformanceQuery;
  const today = formatBangkokDate();
  const dateFrom = filters.date_from ?? today;
  const dateTo = filters.date_to ?? today;
  const dateRange =
    filters.date_from && filters.date_to
      ? buildBangkokDateSpanRange(filters.date_from, filters.date_to)
      : buildBangkokDateRange(today);
  const result = await adminAuditRepository.listWorkerPerformance({
    startAt: dateRange.startAt as Date,
    endAt: dateRange.endAt as Date,
    worker_code: filters.worker_code,
    page: filters.page,
    limit: filters.limit,
    sort_by: filters.sort_by ?? "accept_rate",
    sort_order: filters.sort_order ?? "desc",
  });

  return {
    period: {
      date_from: dateFrom,
      date_to: dateTo,
      timezone: "Asia/Bangkok",
    },
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total: result.total,
      total_pages: Math.ceil(result.total / filters.limit),
    },
    data: result.data,
  };
}

/* -------------------------------------- Audit Events -------------------------------------- */
// Merge event จากข้อมูลเดิม 8 source เป็น unified timeline เดียว ทำที่ TypeScript layer แทน SQL UNION
// เพราะบางกฎต้อง cross-reference ข้าม source กัน (เช่น WorkerAssignmentEvent.ADMIN_CANCELLED กับ
// AdminActionLog.ASSIGNMENT_CANCELLED ต้องรวมเป็น event เดียว ไม่ใช่สอง row ซ้ำกัน)

interface RawAuditEvent extends AdminAuditEventItem {
  search_text: string;
}

// Config event_type ที่นับเป็น severity=critical สำหรับการ์ด "ต้องตรวจสอบ" — ต้องตรงกับกฎที่ Frontend
// ใช้คำนวณการ์ดนี้อยู่แล้ว ห้ามเพิ่ม/ลดโดยไม่เช็คกับ Frontend ก่อน เพราะยอดต้องตรงกันเป๊ะ
const SEVERITY_CRITICAL_EVENT_TYPES = new Set<string>([
  "message_delivery_failed",
  "worker_accept_timeout",
  "worker_scan_timeout",
  "vendor_rejected",
  "vehicle_cancelled",
  "market_cancelled",
  "ticket_cancelled",
  "worker_assignment_cancelled",
  "ticket_worker_cancelled",
  "booth_worker_cancelled",
]);

// Function แปลงค่าเป็น string สำหรับ ID field ที่เป็น nullable แบบเดียวกันทุก event
function toIdString(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return String(value);
}

// Function ตรวจว่า timestamp (ISO string) อยู่ในช่วงที่ filter มาหรือไม่ — ใช้ตอน 1 แถวมีหลาย timestamp
// (เช่น createdAt/workStartedAt/completedAt) ต้องเช็คแยกรายฟิลด์ว่าฟิลด์ไหนอยู่ในช่วงจริงถึงสร้าง event
function isWithinRange(iso: string, range: AdminAuditDateRange): boolean {
  const time = new Date(iso).getTime();

  return time >= range.startAt.getTime() && time < range.endAt.getTime();
}

// Function ประกอบ text สำหรับค้นหาแบบ case-insensitive จากทุกฟิลด์ที่ search รองรับ
function buildSearchText(
  parts: Array<string | number | null | undefined>,
): string {
  return parts
    .filter((part) => part !== null && part !== undefined && part !== "")
    .map((part) => String(part).toLowerCase())
    .join(" ");
}

// Function map แถว TicketJob ดิบเป็น event created/started/completed (สูงสุด 3 event ต่อแถว)
function mapTicketJobEvents(
  rows: AdminAuditTicketJobRow[],
  range: AdminAuditDateRange,
): RawAuditEvent[] {
  const events: RawAuditEvent[] = [];

  for (const row of rows) {
    if (isWithinRange(row.created_at, range)) {
      events.push({
        event_id: `vehicle_job:${row.id}:created`,
        event_type: "vehicle_job_created",
        actor_type: "gate",
        actor_id: null,
        vehicle_job_id: toIdString(row.id),
        market_job_id: null,
        ticket_id: null,
        assignment_id: null,
        worker_id: null,
        reason_code: null,
        reason_text: null,
        metadata: { ticketNumber: row.ticket_number },
        occurred_at: row.created_at,
        search_text: buildSearchText([
          `vehicle_job:${row.id}:created`,
          "vehicle_job_created",
          row.ticket_number,
        ]),
      });
    }

    if (row.work_started_at && isWithinRange(row.work_started_at, range)) {
      events.push({
        event_id: `vehicle_job:${row.id}:started`,
        event_type: "vehicle_job_started",
        actor_type: "system",
        actor_id: null,
        vehicle_job_id: toIdString(row.id),
        market_job_id: null,
        ticket_id: null,
        assignment_id: null,
        worker_id: null,
        reason_code: null,
        reason_text: null,
        metadata: { ticketNumber: row.ticket_number },
        occurred_at: row.work_started_at,
        search_text: buildSearchText([
          `vehicle_job:${row.id}:started`,
          "vehicle_job_started",
          row.ticket_number,
        ]),
      });
    }

    if (row.completed_at && isWithinRange(row.completed_at, range)) {
      events.push({
        event_id: `vehicle_job:${row.id}:completed`,
        event_type: "vehicle_job_completed",
        actor_type: "system",
        actor_id: null,
        vehicle_job_id: toIdString(row.id),
        market_job_id: null,
        ticket_id: null,
        assignment_id: null,
        worker_id: null,
        reason_code: null,
        reason_text: null,
        metadata: { ticketNumber: row.ticket_number },
        occurred_at: row.completed_at,
        search_text: buildSearchText([
          `vehicle_job:${row.id}:completed`,
          "vehicle_job_completed",
          row.ticket_number,
        ]),
      });
    }
  }

  return events;
}

// Function map แถว GateRequestLog ดิบเป็น gate_arrival_received
function mapGateRequestLogEvents(
  rows: AdminAuditGateRequestLogRow[],
): RawAuditEvent[] {
  return rows.map((row) => ({
    event_id: `gate_request:${row.id}:received`,
    event_type: "gate_arrival_received",
    actor_type: "gate",
    actor_id: null,
    vehicle_job_id: toIdString(row.vehicle_job_id),
    market_job_id: toIdString(row.market_job_id),
    ticket_id: null,
    assignment_id: null,
    worker_id: null,
    reason_code: null,
    reason_text: null,
    metadata: {
      ticketNumber: row.ticket_number,
      gateTransactionRef: row.gate_transaction_ref,
      ...(row.ticket_no && { ticketNo: row.ticket_no }),
      ...(row.market_code && { marketCode: row.market_code }),
      ...(row.market_name && { marketName: row.market_name }),
    },
    occurred_at: row.created_at,
    search_text: buildSearchText([
      `gate_request:${row.id}:received`,
      "gate_arrival_received",
      row.ticket_number,
      row.gate_transaction_ref,
      row.ticket_no,
      row.market_code,
      row.market_name,
    ]),
  }));
}

// Function map แถว DriverSession ดิบเป็น driver_qr_opened
function mapDriverSessionEvents(
  rows: AdminAuditDriverSessionRow[],
): RawAuditEvent[] {
  return rows.map((row) => ({
    event_id: `driver_session:${row.id}:opened`,
    event_type: "driver_qr_opened",
    actor_type: "driver",
    actor_id: null,
    vehicle_job_id: toIdString(row.vehicle_job_id),
    market_job_id: null,
    ticket_id: null,
    assignment_id: null,
    worker_id: null,
    reason_code: null,
    reason_text: null,
    metadata: { ticketNumber: row.ticket_number },
    occurred_at: row.created_at,
    search_text: buildSearchText([
      `driver_session:${row.id}:opened`,
      "driver_qr_opened",
      row.ticket_number,
    ]),
  }));
}

const WORKER_ASSIGNMENT_EVENT_TYPE_MAP: Record<string, string> = {
  [WORKER_ASSIGNMENT_EVENT_TYPE.ASSIGNED]: "worker_assigned",
  [WORKER_ASSIGNMENT_EVENT_TYPE.ACCEPTED]: "worker_accepted",
  [WORKER_ASSIGNMENT_EVENT_TYPE.ACCEPT_TIMEOUT]: "worker_accept_timeout",
  [WORKER_ASSIGNMENT_EVENT_TYPE.SCANNED]: "worker_qr_scanned",
  [WORKER_ASSIGNMENT_EVENT_TYPE.SCAN_TIMEOUT]: "worker_scan_timeout",
  [WORKER_ASSIGNMENT_EVENT_TYPE.COMPLETED]: "worker_completed",
  [WORKER_ASSIGNMENT_EVENT_TYPE.ADMIN_CANCELLED]: "worker_assignment_cancelled",
};

// Function map แถว WorkerAssignmentEvent ดิบเป็น event ตามชนิด พร้อม merge กับ AdminActionLog
// (ADMIN_CANCELLED จับคู่กับ ASSIGNMENT_CANCELLED, ASSIGNED ที่มาจาก Manual Assign ให้ Manual Assign log
// เป็น event หลักแทน ไม่คืน worker_assigned ซ้ำ) — คืน consumedAdminActionLogIds กันไม่ให้ AdminActionLog ที่ merge ไปแล้วถูกคืนซ้ำเป็น event แยก
function mapWorkerAssignmentEvents(
  rows: AdminAuditWorkerAssignmentEventRow[],
  manualAssignmentAssignmentIds: Set<number>,
  assignmentCancelLogByAssignmentId: Map<number, AdminActionLogDto>,
): { events: RawAuditEvent[]; consumedAdminActionLogIds: Set<number> } {
  const events: RawAuditEvent[] = [];
  const consumedAdminActionLogIds = new Set<number>();

  for (const row of rows) {
    if (
      row.event_type === WORKER_ASSIGNMENT_EVENT_TYPE.ASSIGNED &&
      manualAssignmentAssignmentIds.has(row.assignment_id)
    ) {
      continue;
    }

    const eventType =
      WORKER_ASSIGNMENT_EVENT_TYPE_MAP[row.event_type] ??
      row.event_type.toLowerCase();
    const isWorkerActor =
      row.event_type === WORKER_ASSIGNMENT_EVENT_TYPE.ACCEPTED ||
      row.event_type === WORKER_ASSIGNMENT_EVENT_TYPE.SCANNED;

    let actorType: AdminAuditEventItem["actor_type"] = isWorkerActor
      ? "worker"
      : "system";
    let actorId: string | null = isWorkerActor
      ? toIdString(row.worker_id)
      : null;
    let reasonCode: string | null = null;
    let reasonText: string | null = null;
    let metadata: Record<string, unknown> | null = {
      ...(row.metadata ?? {}),
      ticketNumber: row.ticket_number,
      workerCode: row.worker_code,
      // ผู้กระทำจริง (ACCEPTED/SCANNED คือ worker เอง) แยกจาก workerCode ด้านบนที่หมายถึงเจ้าของ assignment เสมอ
      ...(isWorkerActor && row.worker_code && { actorCode: row.worker_code }),
      ...(isWorkerActor && row.worker_full_name && { actorName: row.worker_full_name }),
    };

    if (row.event_type === WORKER_ASSIGNMENT_EVENT_TYPE.ADMIN_CANCELLED) {
      const matchedLog = assignmentCancelLogByAssignmentId.get(
        row.assignment_id,
      );

      if (matchedLog) {
        consumedAdminActionLogIds.add(matchedLog.id);
        actorType = "admin";
        actorId = toIdString(matchedLog.actor_account_id);
        reasonCode = matchedLog.reason_code;
        reasonText = matchedLog.reason_text;
        metadata = {
          ...metadata,
          ...(matchedLog.metadata ?? {}),
          ...(matchedLog.actor_username && {
            actorCode: matchedLog.actor_username,
          }),
          ...(matchedLog.actor_full_name && {
            actorName: matchedLog.actor_full_name,
          }),
        };
      }
    }

    events.push({
      event_id: `worker_assignment_event:${row.id}`,
      event_type: eventType,
      actor_type: actorType,
      actor_id: actorId,
      vehicle_job_id: toIdString(row.vehicle_job_id),
      market_job_id: null,
      ticket_id: null,
      assignment_id: toIdString(row.assignment_id),
      worker_id: toIdString(row.worker_id),
      reason_code: reasonCode,
      reason_text: reasonText,
      metadata,
      occurred_at: row.occurred_at,
      search_text: buildSearchText([
        `worker_assignment_event:${row.id}`,
        eventType,
        row.ticket_number,
        row.worker_code,
        row.worker_full_name,
        reasonCode,
        reasonText,
      ]),
    });
  }

  return { events, consumedAdminActionLogIds };
}

// Function map แถว TicketCompletionSubmission ดิบเป็น count_submitted/vendor_rejected/
// vendor_confirmed (สูงสุด 3 event ต่อแถว ตามว่า timestamp ไหนอยู่ในช่วงที่ filter มาบ้าง)
function mapCompletionSubmissionEvents(
  rows: AdminAuditCompletionSubmissionRow[],
  range: AdminAuditDateRange,
): RawAuditEvent[] {
  const events: RawAuditEvent[] = [];

  for (const row of rows) {
    const baseMetadata = {
      ticketNumber: row.ticket_number,
      ticketNo: row.ticket_no,
      boothCode: row.booth_code,
      ...(row.booth_name && { boothName: row.booth_name }),
    };
    const base = {
      vehicle_job_id: toIdString(row.vehicle_job_id),
      market_job_id: toIdString(row.market_job_id),
      ticket_id: toIdString(row.ticket_id),
      assignment_id: toIdString(row.assignment_id),
    };

    if (isWithinRange(row.created_at, range)) {
      const actorType =
        row.submitted_by_role === "admin" ? "admin" : "worker";

      events.push({
        event_id: `submission:${row.id}:submitted`,
        event_type: "count_submitted",
        actor_type: actorType,
        actor_id: toIdString(row.submitted_by_account_id),
        ...base,
        worker_id:
          actorType === "worker"
            ? toIdString(row.submitted_by_account_id)
            : null,
        reason_code: null,
        reason_text: null,
        metadata: {
          ...baseMetadata,
          actorCode: row.submitted_by_code,
          ...(row.submitted_by_full_name && { actorName: row.submitted_by_full_name }),
        },
        occurred_at: row.created_at,
        search_text: buildSearchText([
          `submission:${row.id}:submitted`,
          "count_submitted",
          row.ticket_number,
          row.ticket_no,
          row.booth_code,
          row.booth_name,
          row.submitted_by_code,
          row.submitted_by_full_name,
        ]),
      });
    }

    if (row.rejected_at && isWithinRange(row.rejected_at, range)) {
      const isVendor = Boolean(row.resolved_by_line_user_id);

      events.push({
        event_id: `submission:${row.id}:rejected`,
        event_type: "vendor_rejected",
        actor_type: isVendor ? "vendor" : "system",
        actor_id: isVendor ? row.resolved_by_line_user_id : null,
        ...base,
        worker_id: null,
        reason_code: null,
        reason_text: null,
        metadata: baseMetadata,
        occurred_at: row.rejected_at,
        search_text: buildSearchText([
          `submission:${row.id}:rejected`,
          "vendor_rejected",
          row.ticket_number,
          row.ticket_no,
          row.booth_code,
          row.booth_name,
        ]),
      });
    }

    if (row.confirmed_at && isWithinRange(row.confirmed_at, range)) {
      const isVendor = Boolean(row.resolved_by_line_user_id);

      events.push({
        event_id: `submission:${row.id}:confirmed`,
        event_type: "vendor_confirmed",
        actor_type: isVendor ? "vendor" : "system",
        actor_id: isVendor ? row.resolved_by_line_user_id : null,
        ...base,
        worker_id: null,
        reason_code: null,
        reason_text: null,
        metadata: isVendor
          ? baseMetadata
          : { ...baseMetadata, confirmationSource: "timeout" },
        occurred_at: row.confirmed_at,
        search_text: buildSearchText([
          `submission:${row.id}:confirmed`,
          "vendor_confirmed",
          row.ticket_number,
          row.ticket_no,
          row.booth_code,
          row.booth_name,
        ]),
      });
    }
  }

  return events;
}

// Function map แถว TicketRating ดิบเป็น vendor_rated
function mapTicketRatingEvents(
  rows: AdminAuditTicketRatingRow[],
): RawAuditEvent[] {
  return rows.map((row) => ({
    event_id: `ticket_rating:${row.id}`,
    event_type: "vendor_rated",
    actor_type: "vendor",
    actor_id: row.line_user_id,
    vehicle_job_id: toIdString(row.vehicle_job_id),
    market_job_id: toIdString(row.market_job_id),
    ticket_id: toIdString(row.ticket_id),
    assignment_id: null,
    worker_id: null,
    reason_code: null,
    reason_text: null,
    metadata: {
      ticketNumber: row.ticket_number,
      ticketNo: row.ticket_no,
      boothCode: row.booth_code,
      ...(row.booth_name && { boothName: row.booth_name }),
      score: row.score,
      targetType: row.target_type,
    },
    occurred_at: row.rated_at,
    search_text: buildSearchText([
      `ticket_rating:${row.id}`,
      "vendor_rated",
      row.ticket_number,
      row.ticket_no,
      row.booth_code,
      row.booth_name,
    ]),
  }));
}

// Function map แถว MessageDeliveryLog ดิบเป็น message_delivery_sent/message_delivery_failed —
// repository resolve ไว้แล้วว่า sent_at/failed_at ตัวไหนที่ใช้ได้ตาม status
function mapMessageDeliveryLogEvents(
  rows: AdminAuditMessageDeliveryLogRow[],
): RawAuditEvent[] {
  const events: RawAuditEvent[] = [];

  for (const row of rows) {
    const isSent = row.sent_at !== null;
    const occurredAt = isSent ? row.sent_at : row.failed_at;

    if (!occurredAt) {
      continue;
    }

    const eventType = isSent
      ? "message_delivery_sent"
      : "message_delivery_failed";

    events.push({
      event_id: `message_delivery:${row.id}:${isSent ? "sent" : "failed"}`,
      event_type: eventType,
      actor_type: "system",
      actor_id: null,
      vehicle_job_id: null,
      market_job_id: null,
      ticket_id: null,
      assignment_id: null,
      worker_id: null,
      reason_code: null,
      reason_text: null,
      metadata: {
        channel: row.channel,
        jobName: row.job_name,
        target: row.target,
      },
      occurred_at: occurredAt,
      search_text: buildSearchText([
        `message_delivery:${row.id}`,
        eventType,
        row.channel,
        row.job_name,
        row.target,
      ]),
    });
  }

  return events;
}

// Function map แถว SecurityAuditLog ดิบเป็น auth/security event — ไม่ผูกกับ vehicle/market/ticket/assignment ใดๆ
// actor_type เป็น null ได้กรณี login ด้วย username ที่ไม่มีตัวตนจริง แปลงเป็น "system" ใน response เพราะ
// AdminAuditActorType ไม่มีค่า "unknown" แต่เก็บ attemptedUsername แยกจาก actorCode ไว้ใน Metadata ไม่ให้ปนกัน
function mapSecurityAuditLogEvents(
  rows: SecurityAuditLogDto[],
): RawAuditEvent[] {
  return rows.map((row) => {
    const isAdminActor = row.actor_type === "admin";
    const isWorkerActor = row.actor_type === "worker";
    const actorType: AdminAuditEventItem["actor_type"] = isAdminActor
      ? "admin"
      : isWorkerActor
        ? "worker"
        : "system";
    const actorId = isAdminActor
      ? toIdString(row.actor_account_id)
      : isWorkerActor
        ? toIdString(row.actor_worker_id)
        : null;
    // Mutation event เก็บ before/after ไว้ใน row.metadata.before/.after ตอนเขียน ต้องดึงออกมาเป็น
    // top-level field ตาม contract ไม่ใช่ปล่อยให้ซ้ำอยู่ใน Metadata ด้วย
    const rowMetadata = (row.metadata ?? {}) as {
      before?: Record<string, unknown>;
      after?: Record<string, unknown>;
      [key: string]: unknown;
    };
    const { before: rawBefore, after: rawAfter, ...restMetadata } = rowMetadata;

    return {
      event_id: `security_audit:${row.id}`,
      event_type: row.event_type,
      actor_type: actorType,
      actor_id: actorId,
      vehicle_job_id: null,
      market_job_id: null,
      ticket_id: null,
      assignment_id: null,
      worker_id: isWorkerActor ? toIdString(row.actor_worker_id) : null,
      reason_code: null,
      reason_text: null,
      metadata: {
        outcome: row.outcome,
        ...((isAdminActor || isWorkerActor) && row.actor_username && { actorCode: row.actor_username }),
        ...((isAdminActor || isWorkerActor) && row.actor_full_name && { actorName: row.actor_full_name }),
        ...(!isAdminActor && !isWorkerActor && row.actor_username && {
          attemptedUsername: row.actor_username,
        }),
        ...(row.failure_code && { failureCode: row.failure_code }),
        ...(row.session_id && { sessionId: row.session_id }),
        ...(row.ip_address && { ipAddress: row.ip_address }),
        ...(row.user_agent && { userAgent: row.user_agent }),
        ...(row.request_id && { requestId: row.request_id }),
        ...restMetadata,
      },
      ...(rawBefore && { before: rawBefore }),
      ...(rawAfter && { after: rawAfter }),
      occurred_at: row.created_at,
      search_text: buildSearchText([
        `security_audit:${row.id}`,
        row.event_type,
        row.actor_username,
        row.actor_full_name,
        row.failure_code,
        row.ip_address,
      ]),
    };
  });
}

// Config map AdminActionLog.action_type -> Audit EventType คงที่ — action ที่ต้อง derive event_type
// จาก metadata เพิ่ม (OVERRIDE_COUNT/VEHICLE_WAIT/MANUAL_ASSIGNMENT) handle แยกต่างหาก
const ADMIN_ACTION_EVENT_TYPE_MAP: Partial<Record<string, string>> = {
  [ADMIN_ACTION_TYPE.WORKERS_RELEASED]: "workers_released",
  [ADMIN_ACTION_TYPE.ASSIGNMENT_CANCELLED]: "worker_assignment_cancelled",
  [ADMIN_ACTION_TYPE.SCAN_DEADLINE_EXTENDED]: "scan_timer_extended",
  [ADMIN_ACTION_TYPE.MARKET_JOB_CANCELLED]: "market_cancelled",
  [ADMIN_ACTION_TYPE.VEHICLE_JOB_CANCELLED]: "vehicle_cancelled",
  [ADMIN_ACTION_TYPE.STALL_JOB_CANCELLED]: "ticket_cancelled",
  [ADMIN_ACTION_TYPE.TICKET_WORKER_CANCELLED]: "ticket_worker_cancelled",
  [ADMIN_ACTION_TYPE.TICKET_WORKER_CANCELLED_FROM_BOOTH]: "booth_worker_cancelled",
  [ADMIN_ACTION_TYPE.WORKER_STATUS_FORCED]: "worker_force_status_changed",
};

// Function หา event_type + metadata เสริมของ AdminActionLog แถวหนึ่ง
function resolveAdminActionEventTypeAndMetadata(
  log: AdminActionLogDto & AdminAuditActionLogRow,
): { eventType: string; metadata: Record<string, unknown> | null } {
  const baseMetadata = log.metadata ?? {};

  switch (log.action_type) {
    case ADMIN_ACTION_TYPE.OVERRIDE_COUNT:
      return {
        eventType: "admin_override",
        metadata: { ...baseMetadata, action: "override_count" },
      };
    case ADMIN_ACTION_TYPE.VEHICLE_WAIT: {
      const dispatch =
        (baseMetadata as { dispatch?: boolean }).dispatch === true;

      return dispatch
        ? {
            eventType: "admin_override",
            metadata: { ...baseMetadata, action: "dispatch_vehicle" },
          }
        : { eventType: "job_reverted_to_wait", metadata: baseMetadata };
    }
    case ADMIN_ACTION_TYPE.MANUAL_ASSIGNMENT:
      return {
        eventType: "admin_override",
        metadata: { ...baseMetadata, action: "manual_assign" },
      };
    default: {
      const mapped = ADMIN_ACTION_EVENT_TYPE_MAP[log.action_type];

      return {
        eventType: mapped ?? log.action_type.toLowerCase(),
        metadata: baseMetadata,
      };
    }
  }
}

// Function map แถว AdminActionLog ดิบเป็น event — ข้ามแถวที่ถูก merge เข้ากับ WorkerAssignmentEvent.ADMIN_CANCELLED
// ไปแล้ว (consumedAdminActionLogIds) เพื่อไม่ให้คืนซ้ำสองครั้ง
function mapAdminActionLogEvents(
  rows: Array<AdminActionLogDto & AdminAuditActionLogRow>,
  consumedAdminActionLogIds: Set<number>,
): RawAuditEvent[] {
  const events: RawAuditEvent[] = [];

  for (const row of rows) {
    if (consumedAdminActionLogIds.has(row.id)) {
      continue;
    }

    const { eventType, metadata } = resolveAdminActionEventTypeAndMetadata(row);
    const assignmentId =
      (row.metadata as { assignment_id?: number } | null)?.assignment_id ??
      null;
    const workerId =
      (row.metadata as { worker_id?: number } | null)
        ?.worker_id ?? null;
    const enrichedMetadata = {
      ...(metadata ?? {}),
      ...(row.vehicle_ticket_number && {
        ticketNumber: row.vehicle_ticket_number,
      }),
      ...(row.market_ticket_no && { ticketNo: row.market_ticket_no }),
      ...(row.gate_ticket_booth_code && {
        boothCode: row.gate_ticket_booth_code,
      }),
      ...(row.actor_username && { actorCode: row.actor_username }),
      ...(row.actor_full_name && { actorName: row.actor_full_name }),
    };

    // Before/After เฉพาะ worker_force_status_changed — previous_status มาจากค่า queueEntry.status เดิมก่อนเปลี่ยนสถานะจริง
    // ห้ามสร้างค่าปลอมเมื่อไม่มี queueEntry เดิม (worker ไม่เคยเข้าคิวมาก่อน) จึงส่งเฉพาะ After ในกรณีนั้น
    let before: Record<string, unknown> | undefined;
    let after: Record<string, unknown> | undefined;

    if (eventType === "worker_force_status_changed") {
      const previousStatus = (
        row.metadata as { previous_status?: string | null } | null
      )?.previous_status;
      const targetStatus = (row.metadata as { status?: string } | null)
        ?.status;

      if (previousStatus) {
        before = { status: previousStatus };
      }

      if (targetStatus) {
        after = { status: targetStatus };
      }
    }

    events.push({
      event_id: `admin_action:${row.id}`,
      event_type: eventType,
      actor_type: "admin",
      actor_id: toIdString(row.actor_account_id),
      vehicle_job_id: toIdString(row.vehicle_job_id),
      market_job_id: toIdString(row.market_job_id),
      ticket_id: toIdString(row.gate_ticket_id),
      assignment_id: toIdString(assignmentId),
      worker_id: toIdString(workerId),
      reason_code: row.reason_code,
      reason_text: row.reason_text,
      metadata: enrichedMetadata,
      ...(before && { before }),
      ...(after && { after }),
      occurred_at: row.created_at,
      search_text: buildSearchText([
        `admin_action:${row.id}`,
        eventType,
        row.actor_username,
        row.actor_full_name,
        row.reason_code,
        row.reason_text,
        row.vehicle_ticket_number,
        row.market_ticket_no,
        row.gate_ticket_booth_code,
      ]),
    });
  }

  return events;
}

// Function รวม audit event จากทุก source เป็น timeline เดียว พร้อม filter/quick_filter/summary/pagination
export async function listAuditEvents(
  query: unknown,
  callerPermissions: string[] = [],
): Promise<AdminAuditEventsResponse> {
  const filters = parseWithSchema(
    adminAuditEventsQuerySchema,
    query,
  ) as AdminAuditEventsQuery;
  const today = formatBangkokDate();
  const dateRange =
    filters.date_from && filters.date_to
      ? buildBangkokDateSpanRange(filters.date_from, filters.date_to)
      : buildBangkokDateRange(today);
  const range: AdminAuditDateRange = {
    startAt: dateRange.startAt as Date,
    endAt: dateRange.endAt as Date,
  };
  // security/auth event มีเนื้อหา sensitive กว่า source อื่น (IP, user agent, ความพยายาม login ที่ล้มเหลว)
  // จึงต้องมี audit:read เพิ่มจาก jobs:read ถึงจะเห็น — caller ที่ไม่มี permission นี้ไม่เจอ 403 แค่ไม่เห็น event กลุ่มนี้ในไทม์ไลน์
  const canReadSecurityAudit = callerPermissions.includes("audit:read");

  const [
    ticketJobRows,
    gateRequestLogRows,
    driverSessionRows,
    workerAssignmentEventRows,
    completionSubmissionRows,
    ticketRatingRows,
    messageDeliveryLogRows,
    adminActionLogRows,
    securityAuditLogRows,
  ] = await Promise.all([
    adminAuditRepository.listTicketJobsForAudit(range),
    adminAuditRepository.listGateRequestLogsForAudit(range),
    adminAuditRepository.listDriverSessionsForAudit(range),
    adminAuditRepository.listWorkerAssignmentEventsForAudit(range),
    adminAuditRepository.listCompletionSubmissionsForAudit(range),
    adminAuditRepository.listTicketRatingsForAudit(range),
    adminAuditRepository.listMessageDeliveryLogsForAudit(range),
    adminAuditRepository.listAdminActionLogsForAudit(range),
    canReadSecurityAudit
      ? adminAuditRepository.listSecurityAuditLogsForAudit(range)
      : Promise.resolve([]),
  ]);

  const assignmentCancelLogByAssignmentId = new Map<number, AdminActionLogDto>();
  const manualAssignmentAssignmentIds = new Set<number>();

  for (const log of adminActionLogRows) {
    if (log.action_type === ADMIN_ACTION_TYPE.ASSIGNMENT_CANCELLED) {
      const assignmentId = (
        log.metadata as { assignment_id?: number } | null
      )?.assignment_id;

      if (typeof assignmentId === "number") {
        assignmentCancelLogByAssignmentId.set(assignmentId, log);
      }
    }

    if (log.action_type === ADMIN_ACTION_TYPE.MANUAL_ASSIGNMENT) {
      const assignmentIds = (
        log.metadata as { assignment_ids?: number[] } | null
      )?.assignment_ids;

      for (const assignmentId of assignmentIds ?? []) {
        manualAssignmentAssignmentIds.add(assignmentId);
      }
    }
  }

  const { events: workerAssignmentEvents, consumedAdminActionLogIds } =
    mapWorkerAssignmentEvents(
      workerAssignmentEventRows,
      manualAssignmentAssignmentIds,
      assignmentCancelLogByAssignmentId,
    );

  const allEvents: RawAuditEvent[] = [
    ...mapTicketJobEvents(ticketJobRows, range),
    ...mapGateRequestLogEvents(gateRequestLogRows),
    ...mapDriverSessionEvents(driverSessionRows),
    ...workerAssignmentEvents,
    ...mapCompletionSubmissionEvents(completionSubmissionRows, range),
    ...mapTicketRatingEvents(ticketRatingRows),
    ...mapMessageDeliveryLogEvents(messageDeliveryLogRows),
    ...mapAdminActionLogEvents(adminActionLogRows, consumedAdminActionLogIds),
    ...mapSecurityAuditLogEvents(securityAuditLogRows),
  ];

  // filter จากแถบค้นหา (actor_type/event_type/search + date range) เท่านั้นที่มีผลต่อ Summary ต้องคำนวณ
  // Summary จากชุดนี้ก่อนเสมอ แล้วค่อยเอา quick_filter มากรองต่อสำหรับ Data/Pagination — quick_filter ต้องไม่แตะ Summary
  const searchTerm = filters.search?.toLowerCase();
  const searchFilteredEvents = allEvents.filter((event) => {
    if (filters.actor_type && event.actor_type !== filters.actor_type) {
      return false;
    }

    if (filters.event_type && event.event_type !== filters.event_type) {
      return false;
    }

    if (searchTerm && !event.search_text.includes(searchTerm)) {
      return false;
    }

    return true;
  });

  searchFilteredEvents.sort((left, right) => {
    const timeDiff =
      new Date(right.occurred_at).getTime() -
      new Date(left.occurred_at).getTime();

    if (timeDiff !== 0) {
      return timeDiff;
    }

    return right.event_id.localeCompare(left.event_id);
  });

  const uniqueVehicleIds = new Set<string>();
  let withReasonCount = 0;
  const actorTypeCounts: Record<string, number> = {};
  const eventTypeCounts: Record<string, number> = {};

  for (const event of searchFilteredEvents) {
    if (event.vehicle_job_id) {
      uniqueVehicleIds.add(event.vehicle_job_id);
    }

    // ReasonCode OR ReasonText ต้องนับเป็น "มีเหตุผลประกอบ" เหมือนกับที่ quick_filter=has_reason เช็ค ห้ามนับแค่ reason_code ฝั่งเดียว
    if (event.reason_code || event.reason_text) {
      withReasonCount += 1;
    }

    actorTypeCounts[event.actor_type] =
      (actorTypeCounts[event.actor_type] ?? 0) + 1;
    eventTypeCounts[event.event_type] =
      (eventTypeCounts[event.event_type] ?? 0) + 1;
  }

  const quickFilteredEvents = searchFilteredEvents.filter((event) => {
    switch (filters.quick_filter) {
      case undefined:
        return true;
      case "has_vehicle":
        return event.vehicle_job_id !== null;
      case "has_reason":
        return Boolean(event.reason_code || event.reason_text);
      case "critical":
        return SEVERITY_CRITICAL_EVENT_TYPES.has(event.event_type);
      case "system":
        return event.actor_type === "system";
      case "admin":
        return event.actor_type === "admin";
      default:
        return true;
    }
  });

  const total = quickFilteredEvents.length;
  const startIndex = (filters.page - 1) * filters.limit;
  const pageEvents = quickFilteredEvents
    .slice(startIndex, startIndex + filters.limit)
    .map(({ search_text: _searchText, ...event }) => event);

  return {
    data: pageEvents,
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total,
      total_pages: Math.ceil(total / filters.limit),
    },
    summary: {
      unique_vehicle_count: uniqueVehicleIds.size,
      with_reason_count: withReasonCount,
      actor_type_counts: actorTypeCounts,
      event_type_counts: eventTypeCounts,
    },
  };
}
