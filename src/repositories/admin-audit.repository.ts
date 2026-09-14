// Import Library
import { Prisma } from "@prisma/client";
// Import Mappers
import { client } from "./shared/repository-utils";
import { mapAdminActionLog } from "./shared/mappers";
// Import Config
import { ASSIGNMENT_STATUS } from "../constants/status";
// Import Types
import { WORKER_ASSIGNMENT_EVENT_TYPE } from "../types/shared/worker-assignment-event.type";
import type { DbConnection } from "../types/shared/common.type";
import type { AdminActionLogDto } from "../types/shared/admin-action-log.type";
import type { SecurityAuditLogDto } from "../types/shared/security-audit-log.type";
import type { AdminAuditActionLogRow, AdminAuditCompletionSubmissionRow, AdminAuditDriverSessionRow, AdminAuditGateRequestLogRow, AdminAuditMessageDeliveryLogRow, AdminAuditTicketRatingRow, AdminAuditTicketJobRow, AdminAuditWorkerAssignmentEventRow, AdminAuditWorkerPerformanceQuery, AdminAuditWorkerPerformanceRecord } from "../types/admin-audit.type";

// Type ส่วน ช่วงเวลาที่ใช้ query ข้อมูล Admin Audit
export interface AdminAuditDateRange {
  startAt: Date;
  endAt: Date;
}

// Function แปลง Date เป็น ISO string แบบ nullable สำหรับแถว Audit Events
function toNullableIsoString(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

// Type ส่วน ผลลัพธ์ query ผลงาน worker แบบแบ่งหน้า
export interface WorkerPerformanceResult {
  total: number;
  data: AdminAuditWorkerPerformanceRecord[];
}

type WorkerPerformanceSortBy = NonNullable<
  AdminAuditWorkerPerformanceQuery["sort_by"]
>;

const WORKER_PERFORMANCE_SORT_SQL: Record<WorkerPerformanceSortBy, Prisma.Sql> =
  {
    accept_rate: Prisma.sql`accept_rate_numeric`,
    total_assigned: Prisma.sql`total_assigned_job_count`,
    accepted: Prisma.sql`accepted_job_count`,
    accept_timeout: Prisma.sql`accept_timeout_job_count`,
    scan_timeout: Prisma.sql`scan_timeout_job_count`,
    completed: Prisma.sql`completed_job_count`,
    admin_cancelled: Prisma.sql`admin_cancelled_job_count`,
    worker_code: Prisma.sql`worker_code`,
  };

// Function แปลง sortBy/sortOrder เป็น ORDER BY SQL สำหรับ query worker performance
function buildWorkerPerformanceOrderBy(
  sortBy: WorkerPerformanceSortBy,
  sortOrder: "asc" | "desc",
): Prisma.Sql {
  const sortColumn = WORKER_PERFORMANCE_SORT_SQL[sortBy];

  if (sortBy === "worker_code") {
    return sortOrder === "asc"
      ? Prisma.sql`${sortColumn} ASC`
      : Prisma.sql`${sortColumn} DESC`;
  }

  const metricSort =
    sortOrder === "asc"
      ? Prisma.sql`${sortColumn} ASC NULLS LAST`
      : Prisma.sql`${sortColumn} DESC NULLS LAST`;

  return Prisma.sql`${metricSort}, opportunity_count DESC, completed_job_count DESC, worker_code ASC`;
}

function toNumber(value: unknown): number {
  return Number(value ?? 0);
}

function mapWorkerPerformanceRecord(
  row: Record<string, unknown>,
): AdminAuditWorkerPerformanceRecord {
  return {
    worker_code: String(row.worker_code),
    full_name: String(row.full_name),
    total_assigned_job_count: toNumber(row.total_assigned_job_count),
    accepted_job_count: toNumber(row.accepted_job_count),
    accept_timeout_job_count: toNumber(row.accept_timeout_job_count),
    scan_timeout_job_count: toNumber(row.scan_timeout_job_count),
    completed_job_count: toNumber(row.completed_job_count),
    admin_cancelled_job_count: toNumber(row.admin_cancelled_job_count),
    accept_rate:
      row.accept_rate === null || row.accept_rate === undefined
        ? null
        : Number(row.accept_rate).toFixed(2),
  };
}

// Function สร้าง CTE คำนวณ metric ผลงานของ worker แต่ละคนจาก assignment + event ในช่วงเวลาที่กำหนด
function buildWorkerPerformanceRecordsCte(filters: {
  startAt: Date;
  endAt: Date;
  worker_code?: string;
}): Prisma.Sql {
  const workerFilter = filters.worker_code
    ? Prisma.sql`AND a.labor_code = ${filters.worker_code}`
    : Prisma.empty;

  return Prisma.sql`
    WITH cohort AS (
      SELECT
        vja.id AS assignment_id,
        vja.worker_id,
        vja.ticket_job_id,
        vja.status,
        vja.accepted_at,
        vja.scanned_at
      FROM ticket_job_assignments vja
      JOIN master_workers a ON a.id = vja.worker_id
      WHERE vja.created_at >= ${filters.startAt}
        AND vja.created_at < ${filters.endAt}
        ${workerFilter}
    ),
    assignment_events AS (
      SELECT
        event.assignment_id,
        bool_or(event.event_type = ${WORKER_ASSIGNMENT_EVENT_TYPE.ACCEPTED}) AS has_accepted,
        bool_or(event.event_type = ${WORKER_ASSIGNMENT_EVENT_TYPE.ACCEPT_TIMEOUT}) AS has_accept_timeout,
        bool_or(event.event_type = ${WORKER_ASSIGNMENT_EVENT_TYPE.SCAN_TIMEOUT}) AS has_scan_timeout,
        bool_or(event.event_type = ${WORKER_ASSIGNMENT_EVENT_TYPE.COMPLETED}) AS has_completed,
        bool_or(event.event_type = ${WORKER_ASSIGNMENT_EVENT_TYPE.ADMIN_CANCELLED}) AS has_admin_cancelled
      FROM worker_assignment_events event
      JOIN cohort ON cohort.assignment_id = event.assignment_id
      GROUP BY event.assignment_id
    ),
    assignment_metrics AS (
      SELECT
        a.labor_code AS worker_code,
        a.full_name,
        COUNT(*)::int AS total_assigned_job_count,
        SUM(CASE WHEN cohort.accepted_at IS NOT NULL OR COALESCE(ae.has_accepted, false) THEN 1 ELSE 0 END)::int AS accepted_job_count,
        SUM(CASE WHEN COALESCE(ae.has_accept_timeout, false) OR (cohort.status = ${ASSIGNMENT_STATUS.TIMEOUT} AND cohort.accepted_at IS NULL) THEN 1 ELSE 0 END)::int AS accept_timeout_job_count,
        SUM(CASE WHEN COALESCE(ae.has_scan_timeout, false) OR (cohort.status = ${ASSIGNMENT_STATUS.TIMEOUT} AND cohort.accepted_at IS NOT NULL AND cohort.scanned_at IS NULL) THEN 1 ELSE 0 END)::int AS scan_timeout_job_count,
        SUM(CASE WHEN cohort.status = ${ASSIGNMENT_STATUS.COMPLETED} OR COALESCE(ae.has_completed, false) THEN 1 ELSE 0 END)::int AS completed_job_count,
        SUM(CASE WHEN COALESCE(ae.has_admin_cancelled, false) THEN 1 ELSE 0 END)::int AS admin_cancelled_job_count
      FROM cohort
      JOIN master_workers a ON a.id = cohort.worker_id
      LEFT JOIN assignment_events ae ON ae.assignment_id = cohort.assignment_id
      GROUP BY a.labor_code, a.full_name
    ),
    records AS (
      SELECT
        *,
        accepted_job_count + accept_timeout_job_count AS opportunity_count,
        CASE
          WHEN accepted_job_count + accept_timeout_job_count = 0 THEN NULL
          ELSE ROUND((accepted_job_count::numeric / (accepted_job_count + accept_timeout_job_count)::numeric) * 100, 2)
        END AS accept_rate_numeric
      FROM assignment_metrics
    )
  `;
}

// Function ดึงรายการผลงาน worker แบบแบ่งหน้า พร้อมยอดรวมทั้งหมด
export async function listWorkerPerformance(
  filters: {
    startAt: Date;
    endAt: Date;
    worker_code?: string;
    page: number;
    limit: number;
    sort_by: WorkerPerformanceSortBy;
    sort_order: "asc" | "desc";
  },
  connection?: DbConnection,
): Promise<WorkerPerformanceResult> {
  const db = client(connection);
  const offset = (filters.page - 1) * filters.limit;
  const orderBy = buildWorkerPerformanceOrderBy(
    filters.sort_by,
    filters.sort_order,
  );
  const recordsCte = buildWorkerPerformanceRecordsCte(filters);
  const [countRows, rows] = await Promise.all([
    db.$queryRaw<Array<{ total: number }>>`
      ${recordsCte}
      SELECT COUNT(*)::int AS total FROM records
    `,
    db.$queryRaw<Array<Record<string, unknown>>>`
      ${recordsCte}
    SELECT
      records.worker_code,
      records.full_name,
      records.total_assigned_job_count,
      records.accepted_job_count,
      records.accept_timeout_job_count,
      records.scan_timeout_job_count,
      records.completed_job_count,
      records.admin_cancelled_job_count,
      records.accept_rate_numeric AS accept_rate
    FROM records
    ORDER BY ${orderBy}
    LIMIT ${filters.limit}
    OFFSET ${offset}
    `,
  ]);

  return {
    total: countRows[0] ? toNumber(countRows[0].total) : 0,
    data: rows.map(mapWorkerPerformanceRecord),
  };
}

/* -------------------------------------- Audit Events: Raw Source Queries -------------------------------------- */
// แต่ละ Function ดึงข้อมูลดิบจาก source เดียว ในช่วงเวลาที่ Filter มา (ไม่เกิน 92 วัน) — merge เป็น
// Audit Event ที่สมบูรณ์ทำที่ service เพราะบางกฎต้อง cross-reference ข้าม source เขียนเป็น SQL เดียวยาก

// Function ดึง TicketJob ที่มี timestamp (created/started/completed) อยู่ในช่วงที่ระบุ
export async function listTicketJobsForAudit(
  range: AdminAuditDateRange,
  connection?: DbConnection,
): Promise<AdminAuditTicketJobRow[]> {
  const db = client(connection);
  const rows = await db.ticketJob.findMany({
    where: {
      OR: [
        { createdAt: { gte: range.startAt, lt: range.endAt } },
        { workStartedAt: { gte: range.startAt, lt: range.endAt } },
        { completedAt: { gte: range.startAt, lt: range.endAt } },
      ],
    },
    select: {
      id: true,
      ticketNumber: true,
      createdAt: true,
      workStartedAt: true,
      completedAt: true,
    },
  });

  return rows.map((row) => ({
    id: row.id,
    ticket_number: row.ticketNumber,
    created_at: row.createdAt.toISOString(),
    work_started_at: toNullableIsoString(row.workStartedAt),
    completed_at: toNullableIsoString(row.completedAt),
  }));
}

// Function ดึง GateRequestLog ที่มาถึงในช่วงที่ระบุ
export async function listGateRequestLogsForAudit(
  range: AdminAuditDateRange,
  connection?: DbConnection,
): Promise<AdminAuditGateRequestLogRow[]> {
  const db = client(connection);
  const rows = await db.gateRequestLog.findMany({
    where: { createdAt: { gte: range.startAt, lt: range.endAt } },
    select: {
      id: true,
      ticketJobId: true,
      marketJobId: true,
      gateTransactionRef: true,
      createdAt: true,
      ticketJob: { select: { ticketNumber: true } },
      marketJob: { select: { ticketNo: true, marketCode: true, marketName: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    vehicle_job_id: row.ticketJobId,
    market_job_id: row.marketJobId,
    gate_transaction_ref: row.gateTransactionRef,
    ticket_number: row.ticketJob?.ticketNumber ?? null,
    ticket_no: row.marketJob?.ticketNo ?? null,
    market_code: row.marketJob?.marketCode ?? null,
    market_name: row.marketJob?.marketName ?? null,
    created_at: row.createdAt.toISOString(),
  }));
}

// Function ดึง DriverSession ที่เปิดในช่วงที่ระบุ
export async function listDriverSessionsForAudit(
  range: AdminAuditDateRange,
  connection?: DbConnection,
): Promise<AdminAuditDriverSessionRow[]> {
  const db = client(connection);
  const rows = await db.driverSession.findMany({
    where: { createdAt: { gte: range.startAt, lt: range.endAt } },
    select: {
      id: true,
      ticketJobId: true,
      createdAt: true,
      ticketJob: { select: { ticketNumber: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    vehicle_job_id: row.ticketJobId,
    ticket_number: row.ticketJob?.ticketNumber ?? null,
    created_at: row.createdAt.toISOString(),
  }));
}

// Function ดึง WorkerAssignmentEvent ที่เกิดขึ้นในช่วงที่ระบุ
export async function listWorkerAssignmentEventsForAudit(
  range: AdminAuditDateRange,
  connection?: DbConnection,
): Promise<AdminAuditWorkerAssignmentEventRow[]> {
  const db = client(connection);
  const rows = await db.workerAssignmentEvent.findMany({
    where: { occurredAt: { gte: range.startAt, lt: range.endAt } },
    select: {
      id: true,
      assignmentId: true,
      workerId: true,
      ticketJobId: true,
      eventType: true,
      occurredAt: true,
      metadata: true,
      worker: { select: { laborCode: true, fullName: true } },
      ticketJob: { select: { ticketNumber: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    assignment_id: row.assignmentId,
    worker_id: row.workerId,
    vehicle_job_id: row.ticketJobId,
    event_type: row.eventType,
    occurred_at: row.occurredAt.toISOString(),
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    worker_code: row.worker?.laborCode ?? null,
    worker_full_name: row.worker?.fullName ?? null,
    ticket_number: row.ticketJob?.ticketNumber ?? null,
  }));
}

// Function ดึง TicketCompletionSubmission ที่มี timestamp (submit/reject/confirm) อยู่ในช่วงที่ระบุ
export async function listCompletionSubmissionsForAudit(
  range: AdminAuditDateRange,
  connection?: DbConnection,
): Promise<AdminAuditCompletionSubmissionRow[]> {
  const db = client(connection);
  const rows = await db.ticketCompletionSubmission.findMany({
    where: {
      OR: [
        { createdAt: { gte: range.startAt, lt: range.endAt } },
        { rejectedAt: { gte: range.startAt, lt: range.endAt } },
        { confirmedAt: { gte: range.startAt, lt: range.endAt } },
      ],
    },
    select: {
      id: true,
      ticketId: true,
      assignmentId: true,
      submittedByAccountId: true,
      submittedByWorkerId: true,
      submittedByRole: true,
      createdAt: true,
      rejectedAt: true,
      confirmedAt: true,
      resolvedByLineUserId: true,
      submittedByAccount: { select: { username: true, fullName: true } },
      submittedByWorker: { select: { laborCode: true, fullName: true } },
      ticket: {
        select: {
          boothCode: true,
          boothName: true,
          marketJobId: true,
          ticketJobId: true,
          marketJob: { select: { ticketNo: true } },
          ticketJob: { select: { ticketNumber: true } },
        },
      },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    ticket_id: row.ticketId,
    assignment_id: row.assignmentId,
    submitted_by_account_id: row.submittedByAccountId,
    submitted_by_worker_id: row.submittedByWorkerId,
    submitted_by_role: row.submittedByRole,
    submitted_by_code: row.submittedByAccount?.username ?? row.submittedByWorker?.laborCode ?? null,
    submitted_by_full_name: row.submittedByAccount?.fullName ?? row.submittedByWorker?.fullName ?? null,
    created_at: row.createdAt.toISOString(),
    rejected_at: toNullableIsoString(row.rejectedAt),
    confirmed_at: toNullableIsoString(row.confirmedAt),
    resolved_by_line_user_id: row.resolvedByLineUserId,
    booth_code: row.ticket?.boothCode ?? null,
    booth_name: row.ticket?.boothName ?? null,
    market_job_id: row.ticket?.marketJobId ?? null,
    ticket_no: row.ticket?.marketJob?.ticketNo ?? null,
    vehicle_job_id: row.ticket?.ticketJobId ?? null,
    ticket_number: row.ticket?.ticketJob?.ticketNumber ?? null,
  }));
}

// Function ดึง TicketRating ที่ให้คะแนนในช่วงที่ระบุ
export async function listTicketRatingsForAudit(
  range: AdminAuditDateRange,
  connection?: DbConnection,
): Promise<AdminAuditTicketRatingRow[]> {
  const db = client(connection);
  const rows = await db.ticketRating.findMany({
    where: { ratedAt: { gte: range.startAt, lt: range.endAt } },
    select: {
      id: true,
      ticketId: true,
      submissionId: true,
      lineUserId: true,
      targetType: true,
      score: true,
      ratedAt: true,
      ticket: {
        select: {
          boothCode: true,
          boothName: true,
          marketJobId: true,
          ticketJobId: true,
          marketJob: { select: { ticketNo: true } },
          ticketJob: { select: { ticketNumber: true } },
        },
      },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    ticket_id: row.ticketId,
    submission_id: row.submissionId,
    line_user_id: row.lineUserId,
    target_type: row.targetType,
    score: row.score,
    rated_at: row.ratedAt.toISOString(),
    booth_code: row.ticket?.boothCode ?? null,
    booth_name: row.ticket?.boothName ?? null,
    market_job_id: row.ticket?.marketJobId ?? null,
    ticket_no: row.ticket?.marketJob?.ticketNo ?? null,
    vehicle_job_id: row.ticket?.ticketJobId ?? null,
    ticket_number: row.ticket?.ticketJob?.ticketNumber ?? null,
  }));
}

// Function ดึง MessageDeliveryLog ที่ส่งสำเร็จหรือส่งไม่สำเร็จในช่วงที่ระบุ — ใช้ sentAt สำหรับ SENT
// และ updatedAt สำหรับ FAILED เพราะ FAILED ไม่เคยมี sentAt (ดู updateMessageDeliveryLogStatus)
export async function listMessageDeliveryLogsForAudit(
  range: AdminAuditDateRange,
  connection?: DbConnection,
): Promise<AdminAuditMessageDeliveryLogRow[]> {
  const db = client(connection);
  const rows = await db.messageDeliveryLog.findMany({
    where: {
      OR: [
        { status: "SENT", sentAt: { gte: range.startAt, lt: range.endAt } },
        { status: "FAILED", updatedAt: { gte: range.startAt, lt: range.endAt } },
      ],
    },
    select: {
      id: true,
      channel: true,
      jobName: true,
      target: true,
      status: true,
      sentAt: true,
      updatedAt: true,
    },
  });

  return rows.map((row) => ({
    id: row.id,
    channel: row.channel,
    job_name: row.jobName,
    target: row.target,
    status: row.status,
    sent_at: row.status === "SENT" ? toNullableIsoString(row.sentAt) : null,
    failed_at: row.status === "FAILED" ? row.updatedAt.toISOString() : null,
  }));
}

// Function ดึง AdminActionLog ที่เกิดในช่วงที่ระบุ พร้อม business code เสริม (ticketNumber/ticketNo/
// boothCode) สำหรับค้นหา/แสดงผล — reuse mapper เดียวกับ Work History Timeline สำหรับ field หลัก
export async function listAdminActionLogsForAudit(
  range: AdminAuditDateRange,
  connection?: DbConnection,
): Promise<Array<AdminActionLogDto & AdminAuditActionLogRow>> {
  const db = client(connection);
  const records = await db.adminActionLog.findMany({
    where: { createdAt: { gte: range.startAt, lt: range.endAt } },
    include: {
      actor: true,
      ticketJob: { select: { ticketNumber: true } },
      marketJob: { select: { ticketNo: true } },
      boothJob: { select: { boothCode: true } },
    },
  });

  const result: Array<AdminActionLogDto & AdminAuditActionLogRow> = [];

  for (const record of records) {
    const mapped = mapAdminActionLog(record);

    if (!mapped) {
      continue;
    }

    result.push({
      ...mapped,
      vehicle_ticket_number: record.ticketJob?.ticketNumber ?? null,
      market_ticket_no: record.marketJob?.ticketNo ?? null,
      gate_ticket_booth_code: record.boothJob?.boothCode ?? null,
    });
  }

  return result;
}

// Function ดึง SecurityAuditLog (auth/session event) ที่เกิดในช่วงที่ระบุ — ไม่มี relation ให้ join
// เพราะ actor เป็น snapshot ที่เขียนไว้ตอนสร้างแถวแล้ว ไม่ใช่ live foreign key
export async function listSecurityAuditLogsForAudit(
  range: AdminAuditDateRange,
  connection?: DbConnection,
): Promise<SecurityAuditLogDto[]> {
  const db = client(connection);
  const records = await db.securityAuditLog.findMany({
    where: { createdAt: { gte: range.startAt, lt: range.endAt } },
  });

  return records.map((record) => ({
    id: record.id,
    event_type: record.eventType,
    outcome: record.outcome,
    actor_type: record.actorType,
    actor_account_id: record.actorAccountId,
    actor_worker_id: record.actorWorkerId,
    actor_username: record.actorUsername,
    actor_full_name: record.actorFullName,
    session_id: record.sessionId,
    request_id: record.requestId,
    ip_address: record.ipAddress,
    user_agent: record.userAgent,
    failure_code: record.failureCode,
    metadata: (record.metadata as Record<string, unknown> | null) ?? null,
    created_at: record.createdAt.toISOString(),
  }));
}
