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
  };
}

// Function จัดการ set worker status ใน Redis/BullMQ queue
async function setWorkerStatus(
  accountId: number,
  status: WorkerWorkStatus,
  readyAt: Date | null,
  breakUntil: Date | null
): Promise<WorkerQueueEntryDto> {
  const nowIso = new Date().toISOString();
  const existing = await redis.hgetall(buildWorkerStatusKey(accountId));
  const createdAt = existing.created_at || nowIso;

  await redis.hset(buildWorkerStatusKey(accountId), {
    account_id: String(accountId),
    status,
    ready_at: readyAt ? readyAt.toISOString() : "",
    break_until: breakUntil ? breakUntil.toISOString() : "",
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

// Function อัปเดตสถานะ worker open app ใน Redis/BullMQ queue
export async function markWorkerOpenApp(accountId: number): Promise<WorkerQueueEntryDto> {
  await redis.zrem(REDIS_CONFIG.workerQueueKey, String(accountId));

  return setWorkerStatus(accountId, WORKER_WORK_STATUS.OPEN_APP, null, null);
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

// Function จัดการ record worker heartbeat ใน Redis/BullMQ queue
export async function recordWorkerHeartbeat(
  accountId: number
): Promise<WorkerPresenceDto> {
  const lastSeenAt = new Date().toISOString();
  const settings = await getRuntimeSettings();
  const staleAfterSeconds = settings.worker_presence_stale_seconds;

  await redis.hset(buildWorkerPresenceKey(accountId), {
    account_id: String(accountId),
    last_seen_at: lastSeenAt,
  });
  await redis.expire(
    buildWorkerPresenceKey(accountId),
    staleAfterSeconds * 2
  );

  return mapWorkerPresence({
    last_seen_at: lastSeenAt,
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
      accountId,
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
      accountId,
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

  timeoutWorker.on("failed", (_job, error) => {
    logger.error("Assignment timeout job failed.", { error });
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
