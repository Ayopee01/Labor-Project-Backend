// Import Library
import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
// Import Config
import { buildBullConnection, REDIS_CONFIG } from "../config/redis.config";
// Import Services
import { getRuntimeSettings } from "../services/shared/runtime-settings.service";
// Import Utils
import { getDelayUntil } from "../utils/time";
import { logger } from "../utils/logger";
// Import Types
import type { AssignmentTimeoutJobData, WorkerPresenceDto, WorkerQueueEntryDto, WorkerScheduleJobData } from "../types/worker.type";
import { WORKER_WORK_STATUS, WORKER_WORK_STATUSES, type WorkerWorkStatus } from "../types/shared/worker-status.type";

/* -------------------------------------- Config -------------------------------------- */

// Redis connection สำหรับจัดการ worker queue และ delayed job
const redis = new IORedis(REDIS_CONFIG.url, {
  maxRetriesPerRequest: null,
});

// BullMQ connection สำหรับจัดการ delayed job ของ assignment timeout, scan, warning, vendor และ mobile app release/force update
const bullConnection = buildBullConnection();

// Queue สำหรับ delayed job ของ assignment timeout, scan, warning, vendor และ mobile app release/force update
const assignmentTimeoutQueue = new Queue(REDIS_CONFIG.assignmentTimeoutQueueName, {
  connection: bullConnection,
});

// Queue สำหรับ delayed job ของ worker break return และ shift end
const workerBreakReturnQueue = new Queue(REDIS_CONFIG.workerBreakReturnQueueName, {
  connection: bullConnection,
});

// Retry option สำหรับ accept/scan timeout job เท่านั้น (ต่างจาก job อื่นในไฟล์นี้ที่ไม่ retry) เพราะ job สอง
// ตัวนี้เขียนเปลี่ยนสถานะ assignment ที่ถ้าพลาดแล้วไม่มีอะไรมาประมวลผลซ้ำ จะค้างสถานะถาวร (ดู incident ที่
// interactive transaction หมดเวลา 5000ms เป็นครั้งคราวภายใต้โหลดพร้อมกัน) — retry แบบ exponential backoff
// ให้โอกาสความผิดพลาดชั่ววูบสำเร็จเองในรอบถัดไปโดยไม่ต้องรอ sweep job (ทุก 2 นาที) มาช่วย
const ASSIGNMENT_TIMEOUT_RETRY_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 1000 },
} as const;

let timeoutWorker: Worker | null = null; // Worker สำหรับจัดการ delayed job ของ assignment timeout, scan, warning, vendor และ mobile app release/force update
let breakReturnWorker: Worker | null = null; // Worker สำหรับจัดการ delayed job ของ worker break return และ shift end

let lastWorkerQueueScore = 0; // ค่าลำดับของ worker queue score ล่าสุด (ใช้สำหรับ enqueueWorker)
let lastWorkerQueueFrontScore = 0; // ค่าลำดับของ worker queue score ล่าสุดที่ใช้สำหรับ enqueueWorkersAtFront (ค่าติดลบ) เพื่อให้ worker ที่ enqueue ทีหลังอยู่หน้าคิวเสมอ

/* -------------------------------------- Functions -------------------------------------- */

// Function สร้าง worker status key ใน Redis/BullMQ queue
function buildWorkerStatusKey(accountId: number): string {
  return `${REDIS_CONFIG.workerStatusKeyPrefix}${accountId}`;
}

// Function สร้าง worker presence key ใน Redis/BullMQ queue
function buildWorkerPresenceKey(accountId: number): string {
  return `${REDIS_CONFIG.workerPresenceKeyPrefix}${accountId}`;
}

// Function สร้าง worker break count key ใน Redis/BullMQ queue
function buildWorkerBreakCountKey(accountId: number, shiftInstanceKey: string): string {
  return `${REDIS_CONFIG.workerBreakCountKeyPrefix}${accountId}:${shiftInstanceKey}`;
}

// Function สร้าง worker pending break-retry key ใน Redis/BullMQ queue
function buildWorkerBreakRetryKey(accountId: number): string {
  return `${REDIS_CONFIG.workerBreakRetryKeyPrefix}${accountId}`;
}

// Function แปลง queue status ใน Redis/BullMQ queue
function mapQueueStatus(
  accountId: number,
  status: Record<string, string>
): WorkerQueueEntryDto | null {
  if (!status.status) {
    return null;
  }

  return {
    id: accountId,
    worker_id: accountId,
    status: normalizeWorkerQueueStatus(status.status),
    ready_at: status.ready_at || null,
    break_until: status.break_until || null,
    open_app_reason: status.open_app_reason || null,
    created_at: status.created_at || "",
    updated_at: status.updated_at || "",
  };
}

// Function แปลงให้เป็นรูปแบบกลาง worker queue status ใน Redis/BullMQ queue
function normalizeWorkerQueueStatus(value: string): WorkerWorkStatus {
  return (WORKER_WORK_STATUSES as readonly string[]).includes(value)
    ? value as WorkerWorkStatus
    : WORKER_WORK_STATUS.OPEN_APP;
}

// Function แปลง worker presence ใน Redis/BullMQ queue
function mapWorkerPresence(
  presence: Record<string, string>,
  staleAfterSeconds: number
): WorkerPresenceDto {
  const lastSeenAt = presence.last_seen_at || null;
  const isOnline = lastSeenAt
    ? Date.now() - new Date(lastSeenAt).getTime() <= staleAfterSeconds * 1000
    : false;

  return {
    is_online: isOnline,
    last_seen_at: lastSeenAt,
    stale_after_seconds: staleAfterSeconds,
    session_started_at: presence.session_started_at || null,
  };
}

// Function จัดการ set worker status ใน Redis/BullMQ queue — open_app_reason มีค่าเฉพาะตอน status เป็น
// OPEN_APP เท่านั้น (เคลียร์เป็นค่าว่างทุกครั้งที่เปลี่ยนสถานะไปเป็นอย่างอื่น กัน reason ค้างข้ามรอบ)
async function setWorkerStatus(
  accountId: number,
  status: WorkerWorkStatus,
  readyAt: Date | null,
  breakUntil: Date | null,
  openAppReason?: string | null
): Promise<WorkerQueueEntryDto> {
  const nowIso = new Date().toISOString();
  const existing = await redis.hgetall(buildWorkerStatusKey(accountId));
  const createdAt = existing.created_at || nowIso;

  await redis.hset(buildWorkerStatusKey(accountId), {
    account_id: String(accountId),
    status,
    ready_at: readyAt ? readyAt.toISOString() : "",
    break_until: breakUntil ? breakUntil.toISOString() : "",
    open_app_reason:
      status === WORKER_WORK_STATUS.OPEN_APP ? openAppReason || "" : "",
    created_at: createdAt,
    updated_at: nowIso,
  });

  const latest = await redis.hgetall(buildWorkerStatusKey(accountId));

  return mapQueueStatus(accountId, latest) as WorkerQueueEntryDto;
}

// Function สร้าง worker queue score ใน Redis/BullMQ queue
function buildWorkerQueueScore(): number {
  const now = Date.now();
  const nextScore = now <= lastWorkerQueueScore ? lastWorkerQueueScore + 1 : now;

  lastWorkerQueueScore = nextScore;

  return nextScore;
}

// Function เพิ่มงานเข้า queue worker ใน Redis/BullMQ queue
export async function enqueueWorker(accountId: number): Promise<WorkerQueueEntryDto> {
  const readyScore = buildWorkerQueueScore();
  const readyAt = new Date(readyScore);
  // เขียน status ให้เสร็จก่อน zadd เสมอ เหตุผลเดียวกับ enqueueWorkersAtFront ด้านล่าง
  const queueEntry = await setWorkerStatus(accountId, WORKER_WORK_STATUS.READY, readyAt, null);

  await redis.zadd(
    REDIS_CONFIG.workerQueueKey,
    readyScore,
    String(accountId)
  );

  return queueEntry;
}

// Function จอง worker queue front scores สำหรับ enqueueWorkersAtFront
function reserveWorkerQueueFrontScores(count: number): number {
  lastWorkerQueueFrontScore -= count;
  return lastWorkerQueueFrontScore;
}

// Function เพิ่มงานเข้า queue workers at front ใน Redis/BullMQ queue
export async function enqueueWorkersAtFront(
  accountIds: number[]
): Promise<WorkerQueueEntryDto[]> {
  const uniqueAccountIds = [...new Set(accountIds)];

  if (uniqueAccountIds.length === 0) {
    return [];
  }

  const firstScore = reserveWorkerQueueFrontScores(uniqueAccountIds.length);
  const readyAt = new Date();
  const entries: WorkerQueueEntryDto[] = [];

  for (const [index, accountId] of uniqueAccountIds.entries()) {
    // เขียน status ให้เสร็จก่อน zadd เสมอ เพราะถ้าเกิด concurrent dispatch ดึง worker คนเดียวกันออกจากคิวซ้ำ จะได้ไม่เกิด race condition ที่ worker ถูก pop ออกจากคิวแล้วแต่ status hash ยังไม่อัปเดตเป็น READY ให้สั้นที่สุด
    const queueEntry = await setWorkerStatus(accountId, WORKER_WORK_STATUS.READY, readyAt, null);

    await redis.zadd(
      REDIS_CONFIG.workerQueueKey,
      firstScore + index,
      String(accountId)
    );
    entries.push(queueEntry);
  }

  return entries;
}

// Function อัปเดตสถานะ worker open app ใน Redis/BullMQ queue — reason (ถ้ามี) ใช้บอกสาเหตุที่ถูกเด้งมา
// open_app เพื่อให้ GET /api/workers/me/status ตอบ reason_code ที่ตรงจุดกลับไปได้
export async function markWorkerOpenApp(
  accountId: number,
  reason?: string
): Promise<WorkerQueueEntryDto> {
  await redis.zrem(REDIS_CONFIG.workerQueueKey, String(accountId));

  return setWorkerStatus(accountId, WORKER_WORK_STATUS.OPEN_APP, null, null, reason);
}

// Function อัปเดตสถานะ worker assigned ใน Redis/BullMQ queue
export async function markWorkerAssigned(accountId: number): Promise<WorkerQueueEntryDto> {
  await redis.zrem(REDIS_CONFIG.workerQueueKey, String(accountId));

  return setWorkerStatus(accountId, WORKER_WORK_STATUS.ASSIGNED, null, null);
}

// Function อัปเดตสถานะ worker break ใน Redis/BullMQ queue
export async function markWorkerBreak(
  accountId: number,
  breakUntil: Date
): Promise<WorkerQueueEntryDto> {
  await redis.zrem(REDIS_CONFIG.workerQueueKey, String(accountId));

  return setWorkerStatus(accountId, WORKER_WORK_STATUS.BREAK, null, breakUntil);
}

// Function อัปเดตสถานะ worker ready ใน Redis/BullMQ queue
export async function claimWorkerFromReadyQueue(accountId: number): Promise<boolean> {
  const removed = await redis.zrem(REDIS_CONFIG.workerQueueKey, String(accountId));

  return removed === 1;
}

// Function จัดการ pop ready workers จาก Redis FIFO แบบ atomic
export async function popReadyWorkers(limit: number): Promise<WorkerQueueEntryDto[]> {
  if (limit <= 0) {
    return [];
  }

  // ZPOPMIN เป็น atomic command ป้องกัน concurrent dispatch ดึง worker คนเดียวกันออกจากคิวซ้ำ
  const popped = await redis.zpopmin(
    REDIS_CONFIG.workerQueueKey,
    limit
  );

  if (popped.length === 0) {
    return [];
  }

  // แยก accountIds ออกจาก popped (popped เป็น array ของ [accountId, score] สลับกัน)
  const accountIds = popped.filter(
    (_value, index) => index % 2 === 0
  );

  // อัปเดตสถานะ worker เป็น assigned หลังจาก pop ออกจาก ready queue เสร็จแล้ว
  return Promise.all(
    accountIds.map((accountIdValue) =>
      markWorkerAssigned(Number(accountIdValue))
    )
  );
}

// Function ดึง worker queue status ใน Redis/BullMQ queue
export async function getWorkerQueueStatus(
  accountId: number
): Promise<WorkerQueueEntryDto | null> {
  const status = await redis.hgetall(buildWorkerStatusKey(accountId));

  return mapQueueStatus(accountId, status);
}

// Function ดึง worker queue statuses ใน Redis/BullMQ queue
export async function getWorkerQueueStatuses(
  accountIds: number[]
): Promise<Map<number, WorkerQueueEntryDto | null>> {
  const result = new Map<number, WorkerQueueEntryDto | null>();

  if (accountIds.length === 0) {
    return result;
  }

  const pipeline = redis.pipeline();

  for (const accountId of accountIds) {
    pipeline.hgetall(buildWorkerStatusKey(accountId));
  }

  const responses = await pipeline.exec();

  accountIds.forEach((accountId, index) => {
    const [, value] = responses?.[index] ?? [null, {}];
    result.set(
      accountId,
      mapQueueStatus(accountId, (value ?? {}) as Record<string, string>)
    );
  });

  return result;
}

// Function ดึง worker ready queue ranks ใน Redis/BullMQ queue
export async function getWorkerReadyQueueRanks(
  accountIds: number[]
): Promise<Map<number, number | null>> {
  const result = new Map<number, number | null>();

  if (accountIds.length === 0) {
    return result;
  }

  const pipeline = redis.pipeline();

  for (const accountId of accountIds) {
    pipeline.zrank(REDIS_CONFIG.workerQueueKey, String(accountId));
  }

  const responses = await pipeline.exec();

  accountIds.forEach((accountId, index) => {
    const [, value] = responses?.[index] ?? [null, null];
    const rank = value === null || value === undefined ? null : Number(value);

    result.set(accountId, Number.isFinite(rank) ? rank : null);
  });

  return result;
}

// Function จัดการ record worker heartbeat ใน Redis/BullMQ queue — แยก session_started_at ออกจาก
// last_seen_at: ตั้งค่าใหม่เฉพาะตอนเปลี่ยนจาก offline/stale (ไม่เคย seen หรือ seen ครั้งก่อนเกิน stale
// window ไปแล้ว รวมถึง Redis key หมดอายุ/server restart) มาเป็น online เท่านั้น ส่วน reconnect ภายใน
// grace period และ heartbeat ต่อเนื่องต้องคง session_started_at เดิมไว้ ไม่งั้น admin worker status
// (ข้อ 37) จะเห็นเวลาเข้าสถานะ open_app กระโดดทุกครั้งที่ socket reconnect/ping
export async function recordWorkerHeartbeat(
  accountId: number
): Promise<WorkerPresenceDto> {
  const lastSeenAt = new Date().toISOString();
  const settings = await getRuntimeSettings();
  const staleAfterSeconds = settings.worker_presence_stale_seconds;

  const existing = await redis.hgetall(buildWorkerPresenceKey(accountId));
  const previousLastSeenAt = existing.last_seen_at || null;
  const wasOnline = previousLastSeenAt
    ? Date.now() - new Date(previousLastSeenAt).getTime() <= staleAfterSeconds * 1000
    : false;
  const sessionStartedAt = wasOnline
    ? existing.session_started_at || lastSeenAt
    : lastSeenAt;

  await redis.hset(buildWorkerPresenceKey(accountId), {
    account_id: String(accountId),
    last_seen_at: lastSeenAt,
    session_started_at: sessionStartedAt,
  });
  await redis.expire(
    buildWorkerPresenceKey(accountId),
    staleAfterSeconds * 2
  );

  return mapWorkerPresence({
    last_seen_at: lastSeenAt,
    session_started_at: sessionStartedAt,
  }, staleAfterSeconds);
}

// Function ล้าง worker presence ทันทีตอน session ถูก revoke ชัดเจน (logout/admin) กันค้างเป็น online จนกว่า TTL จะหมดอายุเอง
export async function clearWorkerPresence(accountId: number): Promise<void> {
  await redis.del(buildWorkerPresenceKey(accountId));
}

// Function ดึง worker presence ใน Redis/BullMQ queue
export async function getWorkerPresence(
  accountId: number
): Promise<WorkerPresenceDto> {
  const presence = await redis.hgetall(buildWorkerPresenceKey(accountId));
  const settings = await getRuntimeSettings();

  return mapWorkerPresence(presence, settings.worker_presence_stale_seconds);
}

// Function ดึง worker presences ใน Redis/BullMQ queue
export async function getWorkerPresences(
  accountIds: number[]
): Promise<Map<number, WorkerPresenceDto>> {
  const result = new Map<number, WorkerPresenceDto>();

  if (accountIds.length === 0) {
    return result;
  }

  const pipeline = redis.pipeline();
  const settings = await getRuntimeSettings();

  for (const accountId of accountIds) {
    pipeline.hgetall(buildWorkerPresenceKey(accountId));
  }

  const responses = await pipeline.exec();

  accountIds.forEach((accountId, index) => {
    const [, value] = responses?.[index] ?? [null, {}];
    result.set(
      accountId,
      mapWorkerPresence(
        (value ?? {}) as Record<string, string>,
        settings.worker_presence_stale_seconds
      )
    );
  });

  return result;
}

// Function ดึง worker break count ใน Redis/BullMQ queue
export async function getWorkerBreakCount(
  accountId: number,
  shiftInstanceKey: string
): Promise<number> {
  const value = await redis.get(buildWorkerBreakCountKey(accountId, shiftInstanceKey));

  return value ? Number(value) : 0;
}

// Function เพิ่ม break count แบบ atomic และคืนค่าหลัง increment
export async function incrementWorkerBreakCount(
  accountId: number,
  shiftInstanceKey: string
): Promise<number> {
  const key = buildWorkerBreakCountKey(accountId, shiftInstanceKey);
  const count = await redis.incr(key);
  const settings = await getRuntimeSettings();

  await redis.expire(key, settings.worker_break_count_ttl_hours * 60 * 60);

  return count;
}

// Function คืน break count หนึ่งครั้งเมื่อ request เกิน limit
export async function decrementWorkerBreakCount(
  accountId: number,
  shiftInstanceKey: string
): Promise<void> {
  await redis.decr(buildWorkerBreakCountKey(accountId, shiftInstanceKey));
}

// Function ตั้ง pending marker ไว้ตอน auto break-return fallback เป็น open_app เพราะ socket ไม่ connected
// เก็บ scheduleId ของกะที่พักอยู่ไว้เทียบตอน worker ต่อ socket กลับมา — TTL จำกัดเป็นหน้าต่างเวลาที่ยอม
// retry เท่านั้น (ไม่ใช่ทั้งกะ) กันกรณี schedule.id ตรงกันข้ามวันถัดไป (recurring schedule) แต่ไม่ใช่กะเดียวกันจริง
export async function markWorkerPendingBreakReturn(
  accountId: number,
  scheduleId: number,
  ttlSeconds: number
): Promise<void> {
  if (ttlSeconds <= 0) {
    return;
  }

  const key = buildWorkerBreakRetryKey(accountId);

  await redis.hset(key, {
    schedule_id: String(scheduleId),
  });
  await redis.expire(key, ttlSeconds);
}

// Function ดึง scheduleId ที่ค้าง pending break-retry อยู่ของ worker ใน Redis/BullMQ queue
export async function getWorkerPendingBreakReturnScheduleId(
  accountId: number
): Promise<number | null> {
  const value = await redis.hgetall(buildWorkerBreakRetryKey(accountId));

  return value.schedule_id ? Number(value.schedule_id) : null;
}

// Function ล้าง pending break-retry ของ worker ใน Redis/BullMQ queue
export async function clearWorkerPendingBreakReturn(accountId: number): Promise<void> {
  await redis.del(buildWorkerBreakRetryKey(accountId));
}

// Function ตั้งเวลา delayed job assignment timeout ใน Redis/BullMQ queue
export async function scheduleAssignmentTimeout(
  assignmentId: number,
  workerId: number,
  delayMs: number
): Promise<void> {
  await assignmentTimeoutQueue.add(
    "assignment-timeout",
    {
      assignmentId,
      workerId,
      kind: "accept",
    },
    {
      delay: delayMs,
      jobId: `assignment-timeout-${assignmentId}`,
      removeOnComplete: true,
      removeOnFail: 100,
      ...ASSIGNMENT_TIMEOUT_RETRY_OPTIONS,
    }
  );
}

// Function ลบ assignment timeout ใน Redis/BullMQ queue
export async function removeAssignmentTimeout(assignmentId: number): Promise<void> {
  const job = await assignmentTimeoutQueue.getJob(`assignment-timeout-${assignmentId}`);

  if (job) {
    await job.remove();
  }
}

// Function ตั้ง delayed job สำหรับ timeout การ scan QR หลัง accept assignment
export async function scheduleScanTimeout(
  assignmentId: number,
  workerId: number,
  delayMs: number
): Promise<void> {
  await removeScanTimeout(assignmentId);
  await assignmentTimeoutQueue.add(
    "assignment-scan-timeout",
    {
      assignmentId,
      workerId,
      kind: "scan",
    },
    {
      delay: delayMs,
      jobId: `assignment-scan-timeout-${assignmentId}`,
      removeOnComplete: true,
      removeOnFail: 100,
      ...ASSIGNMENT_TIMEOUT_RETRY_OPTIONS,
    }
  );
}

// Function ลบ scan timeout ใน Redis/BullMQ queue
export async function removeScanTimeout(assignmentId: number): Promise<void> {
  const job = await assignmentTimeoutQueue.getJob(`assignment-scan-timeout-${assignmentId}`);

  if (job) {
    await job.remove();
  }
}

// Function ตั้งเวลา delayed job scan warning ใน Redis/BullMQ queue
export async function scheduleScanWarning(
  assignmentId: number,
  workerId: number,
  scanDeadlineAt: string | null
): Promise<void> {
  await removeScanWarning(assignmentId);
  const remainingDelayMs = getDelayUntil(scanDeadlineAt);

  if (remainingDelayMs <= 0) {
    return;
  }

  const settings = await getRuntimeSettings();
  const warningBeforeMs = settings.worker_scan_warning_before_minutes * 60 * 1000;
  const warningDelayMs = Math.max(0, remainingDelayMs - warningBeforeMs);

  await assignmentTimeoutQueue.add(
    "assignment-scan-warning",
    {
      assignmentId,
      workerId,
      kind: "scan_warning",
    },
    {
      delay: warningDelayMs,
      jobId: `assignment-scan-warning-${assignmentId}`,
      removeOnComplete: true,
      removeOnFail: 100,
    }
  );
}

// Function ลบ scan warning ใน Redis/BullMQ queue
export async function removeScanWarning(assignmentId: number): Promise<void> {
  const job = await assignmentTimeoutQueue.getJob(`assignment-scan-warning-${assignmentId}`);

  if (job) {
    await job.remove();
  }
}

// Function ตั้งเวลา delayed job vendor confirmation timeout ใน Redis/BullMQ queue
export async function scheduleVendorConfirmationTimeout(
  ticketId: number,
  submissionId: number,
  delayMs: number
): Promise<void> {
  await removeVendorConfirmationTimeout(ticketId, submissionId);
  await assignmentTimeoutQueue.add(
    "vendor-confirm-timeout",
    {
      ticketId,
      submissionId,
      kind: "vendor_confirm",
    },
    {
      delay: delayMs,
      jobId: `vendor-confirm-timeout-${ticketId}-${submissionId}`,
      removeOnComplete: true,
      removeOnFail: 100,
    }
  );
}

// Function ลบ vendor confirmation timeout ใน Redis/BullMQ queue
export async function removeVendorConfirmationTimeout(
  ticketId: number,
  submissionId: number
): Promise<void> {
  const job = await assignmentTimeoutQueue.getJob(
    `vendor-confirm-timeout-${ticketId}-${submissionId}`
  );

  if (job) {
    await job.remove();
  }
}

// Function ตรวจว่ามี vendor confirmation timeout job อยู่ใน queue
export async function hasVendorConfirmationTimeout(
  ticketId: number,
  submissionId: number
): Promise<boolean> {
  const job = await assignmentTimeoutQueue.getJob(
    `vendor-confirm-timeout-${ticketId}-${submissionId}`
  );

  return Boolean(job);
}

// Function ตั้ง delayed job สำหรับ release notification
export async function scheduleMobileAppReleaseNotification(
  mobileAppVersionId: number,
  delayMs: number
): Promise<void> {
  await assignmentTimeoutQueue.add(
    "mobile-app-release-notification",
    {
      mobileAppVersionId,
      kind: "mobile_app_release_notification",
    },
    {
      delay: delayMs,
      jobId: `mobile-app-release-notification-${mobileAppVersionId}`,
      removeOnComplete: true,
      removeOnFail: 100,
    }
  );
}

// Function ลบ delayed job ส่ง FCM Release Notification ใน Redis/BullMQ queue
export async function removeMobileAppReleaseNotification(
  mobileAppVersionId: number
): Promise<void> {
  const job = await assignmentTimeoutQueue.getJob(
    `mobile-app-release-notification-${mobileAppVersionId}`
  );

  if (job) {
    await job.remove();
  }
}

// Function ตั้ง delayed job สำหรับ force-update notification
export async function scheduleMobileAppForceUpdateNotification(
  mobileAppVersionId: number,
  delayMs: number
): Promise<void> {
  await assignmentTimeoutQueue.add(
    "mobile-app-force-update-notification",
    {
      mobileAppVersionId,
      kind: "mobile_app_force_update_notification",
    },
    {
      delay: delayMs,
      jobId: `mobile-app-force-update-notification-${mobileAppVersionId}`,
      removeOnComplete: true,
      removeOnFail: 100,
    }
  );
}

// Function ลบ delayed job ส่ง FCM บังคับอัปเดตอัตโนมัติ ใน Redis/BullMQ queue
export async function removeMobileAppForceUpdateNotification(
  mobileAppVersionId: number
): Promise<void> {
  const job = await assignmentTimeoutQueue.getJob(
    `mobile-app-force-update-notification-${mobileAppVersionId}`
  );

  if (job) {
    await job.remove();
  }
}

// Function ตั้ง delayed job สำหรับพา worker กลับจาก break
export async function scheduleWorkerBreakReturn(
  accountId: number,
  scheduleId: number,
  delayMs: number
): Promise<void> {
  // Function ลบ delayed job เดิมก่อน schedule ใหม่
  await removeWorkerBreakReturn(accountId, scheduleId);
  await workerBreakReturnQueue.add(
    "worker-break-return",
    {
      // key ต้องชื่อ workerId ให้ตรงกับที่ startWorkerBreakReturnWorker (worker-dispatch.ts) destructure —
      // เดิมใช้ accountId ทำให้ workerId เป็น undefined เสมอตอน consume แล้ว handleWorkerBreakReturn
      // return เงียบๆ ทันทีที่ getWorkerQueueStatus(undefined) ไม่เจอ entry (บั๊กทำให้ auto-return-from-break
      // ทั้งระบบไม่ทำงานเลย ไม่ requeue ไม่ push แจ้งเตือนอะไรทั้งสิ้น)
      workerId: accountId,
      scheduleId,
      kind: "break_return",
    },
    {
      delay: delayMs,
      jobId: `worker-break-return-${accountId}-${scheduleId}`,
      removeOnComplete: true,
      removeOnFail: 100,
    }
  );
}

// Function ตั้งเวลา delayed job worker shift end ใน Redis/BullMQ queue
export async function scheduleWorkerShiftEnd(
  accountId: number,
  scheduleId: number,
  delayMs: number,
  shiftInstanceKey?: string
): Promise<void> {
  await removeWorkerShiftEnd(accountId, scheduleId);
  await workerBreakReturnQueue.add(
    "worker-shift-end",
    {
      // key ต้องชื่อ workerId เหตุผลเดียวกับ scheduleWorkerBreakReturn ด้านบน — accountId เดิมทำให้
      // handleWorkerShiftEnd ได้ workerId เป็น undefined เสมอ auto-eject worker ตอนหมดกะไม่ทำงาน
      workerId: accountId,
      scheduleId,
      shiftInstanceKey,
      kind: "shift_end",
    },
    {
      delay: delayMs,
      jobId: `worker-shift-end-${accountId}-${scheduleId}`,
      removeOnComplete: true,
      removeOnFail: 100,
    }
  );
}

// Function ลบ worker shift end ใน Redis/BullMQ queue
async function removeWorkerShiftEnd(
  accountId: number,
  scheduleId: number
): Promise<void> {
  const job = await workerBreakReturnQueue.getJob(
    `worker-shift-end-${accountId}-${scheduleId}`
  );

  if (job) {
    await job.remove();
  }
}

// Function ลบ worker break return ใน Redis/BullMQ queue
export async function removeWorkerBreakReturn(
  accountId: number,
  scheduleId: number
): Promise<void> {
  const job = await workerBreakReturnQueue.getJob(
    `worker-break-return-${accountId}-${scheduleId}`
  );

  if (job) {
    await job.remove();
  }
}

// Function ตั้ง delayed job แจ้งเตือน worker + admin ตอนหน้าต่างเวลา worker_break_retry หมดอายุโดยที่
// worker ยังไม่กลับมาต่อ socket เลย — delay เท่ากับ TTL เดียวกับ marker ที่ markWorkerPendingBreakReturn
// ตั้งไว้ ให้ยิงพร้อมกันพอดี (ดู handleWorkerBreakReturn/retryWorkerBreakReturnOnConnect ใน worker-dispatch.ts)
export async function scheduleWorkerBreakRetryExpiry(
  workerId: number,
  scheduleId: number,
  delayMs: number
): Promise<void> {
  if (delayMs <= 0) {
    return;
  }

  await removeWorkerBreakRetryExpiry(workerId, scheduleId);
  await workerBreakReturnQueue.add(
    "worker-break-retry-expired",
    {
      workerId,
      scheduleId,
      kind: "break_retry_expired",
    },
    {
      delay: delayMs,
      jobId: `worker-break-retry-expired-${workerId}-${scheduleId}`,
      removeOnComplete: true,
      removeOnFail: 100,
    }
  );
}

// Function ลบ delayed job แจ้งเตือนหน้าต่างเวลา worker_break_retry หมดอายุ ใน Redis/BullMQ queue — เรียก
// ตอน worker กลับมาต่อ socket ทันเวลาแล้ว (ไม่ต้องแจ้ง "กรุณาติดต่อ Admin" อีก)
export async function removeWorkerBreakRetryExpiry(
  workerId: number,
  scheduleId: number
): Promise<void> {
  const job = await workerBreakReturnQueue.getJob(
    `worker-break-retry-expired-${workerId}-${scheduleId}`
  );

  if (job) {
    await job.remove();
  }
}

// Function เริ่ม assignment timeout worker ใน Redis/BullMQ queue
export function startAssignmentTimeoutWorker(
  handler: (data: AssignmentTimeoutJobData) => Promise<void>
): void {
  if (timeoutWorker) {
    return;
  }

  timeoutWorker = new Worker(
    REDIS_CONFIG.assignmentTimeoutQueueName,
    async (job: Job<AssignmentTimeoutJobData>) => {
      await handler(job.data);
    },
    {
      connection: bullConnection,
    }
  );

  timeoutWorker.on("failed", (job, error) => {
    logger.error("Assignment timeout job failed.", {
      jobId: job?.id,
      kind: job?.data?.kind,
      attemptsMade: job?.attemptsMade,
      attempts: job?.opts?.attempts,
      error,
    });
  });
}

// Function เริ่ม worker break return worker ใน Redis/BullMQ queue
export function startWorkerBreakReturnWorker(
  handler: (data: WorkerScheduleJobData) => Promise<void>
): void {
  if (breakReturnWorker) {
    return;
  }

  breakReturnWorker = new Worker(
    REDIS_CONFIG.workerBreakReturnQueueName,
    async (job: Job<WorkerScheduleJobData>) => {
      await handler(job.data);
    },
    {
      connection: bullConnection,
    }
  );

  breakReturnWorker.on("failed", (_job, error) => {
    logger.error("Worker break return job failed.", { error });
  });
}

// Function ปิด Redis และ BullMQ connections สำหรับ test หรือ graceful shutdown
export async function closeWorkerQueueConnections(): Promise<void> {
  if (timeoutWorker) {
    await timeoutWorker.close();
    timeoutWorker = null;
  }

  if (breakReturnWorker) {
    await breakReturnWorker.close();
    breakReturnWorker = null;
  }

  await Promise.all([
    assignmentTimeoutQueue.close(),
    workerBreakReturnQueue.close(),
  ]);

  if (redis.status !== "end") {
    await redis.quit();
  }
}
