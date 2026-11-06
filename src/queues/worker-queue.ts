// Import Library
import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
// Import Config
import { REDIS_CONFIG } from "../config/redis.config";
// Import Queues
import { bullProducerConnection, bullWorkerConnection } from "./bull-connection";
// Import Services
import { getRuntimeSettings } from "../services/shared/runtime-settings.service";
// Import Types
import type { AssignmentTimeoutJobData, WorkerPresenceDto, WorkerQueueEntryDto, WorkerScheduleJobData } from "../types/worker.type";
import { WORKER_WORK_STATUS, WORKER_WORK_STATUSES, type WorkerWorkStatus } from "../types/shared/worker-status.type";
// Import Utils
import { runWithLogContext } from "../utils/log-context";
import { getDelayUntil } from "../utils/time";
import { logger } from "../utils/logger";

/* -------------------------------------- Config -------------------------------------- */

// Config Lua เขียนสถานะ worker และเพิ่ม/ลบใน ready queue ในคำสั่งเดียว (ARGV[7] ว่าง = ลบออกจากคิว)
const SET_WORKER_QUEUE_STATE_LUA = `
redis.call('HSETNX', KEYS[1], 'created_at', ARGV[6])
redis.call('HSET', KEYS[1], 'account_id', ARGV[1], 'status', ARGV[2], 'ready_at', ARGV[3],
  'break_until', ARGV[4], 'open_app_reason', ARGV[5], 'updated_at', ARGV[6])
if ARGV[7] == '' then
  redis.call('ZREM', KEYS[2], ARGV[1])
else
  redis.call('ZADD', KEYS[2], ARGV[7], ARGV[1])
end
return redis.call('HGETALL', KEYS[1])
`;

// Config Lua pop worker จากหัวคิวพร้อมเปลี่ยนเป็น assigned ทิ้งสมาชิกที่สถานะไม่ใช่ ready (สถานะค้าง)
const POP_READY_WORKERS_LUA = `
local result = {}
while #result < tonumber(ARGV[2]) do
  local popped = redis.call('ZPOPMIN', KEYS[1])
  if #popped == 0 then
    break
  end
  local accountId = popped[1]
  local statusKey = ARGV[1] .. accountId
  if redis.call('HGET', statusKey, 'status') == ARGV[3] then
    redis.call('HSETNX', statusKey, 'created_at', ARGV[5])
    redis.call('HSET', statusKey, 'account_id', accountId, 'status', ARGV[4], 'ready_at', '',
      'break_until', '', 'open_app_reason', '', 'updated_at', ARGV[5])
    table.insert(result, accountId)
  end
end
return result
`;

// Config Lua ดึง worker คนที่ระบุออกจากคิวพร้อมเปลี่ยนเป็น assigned (คืน 0 ถ้าไม่อยู่ในคิวหรือสถานะไม่ใช่ ready)
const CLAIM_READY_WORKER_LUA = `
if redis.call('ZREM', KEYS[2], ARGV[1]) == 0 then
  return 0
end
if redis.call('HGET', KEYS[1], 'status') ~= ARGV[2] then
  return 0
end
redis.call('HSETNX', KEYS[1], 'created_at', ARGV[4])
redis.call('HSET', KEYS[1], 'account_id', ARGV[1], 'status', ARGV[3], 'ready_at', '',
  'break_until', '', 'open_app_reason', '', 'updated_at', ARGV[4])
return 1
`;

// Type Redis client ที่มีคำสั่ง Lua ของคิว worker
type WorkerQueueRedis = IORedis & {
  setWorkerQueueState(statusKey: string, queueKey: string, ...args: string[]): Promise<string[]>;
  popReadyWorkersAtomic(
    queueKey: string,
    statusKeyPrefix: string,
    limit: string,
    readyStatus: string,
    assignedStatus: string,
    nowIso: string
  ): Promise<string[]>;
  claimReadyWorkerAtomic(
    statusKey: string,
    queueKey: string,
    accountId: string,
    readyStatus: string,
    assignedStatus: string,
    nowIso: string
  ): Promise<number>;
};

// Config Redis connection ของคิว worker (ใช้ connection ฝั่ง producer ร่วมกัน ล้มเร็วเมื่อ Redis ล่ม request จะได้ไม่ค้าง)
const redis = bullProducerConnection as WorkerQueueRedis;

redis.defineCommand("setWorkerQueueState", { numberOfKeys: 2, lua: SET_WORKER_QUEUE_STATE_LUA });
redis.defineCommand("popReadyWorkersAtomic", { numberOfKeys: 1, lua: POP_READY_WORKERS_LUA });
redis.defineCommand("claimReadyWorkerAtomic", { numberOfKeys: 2, lua: CLAIM_READY_WORKER_LUA });

// Config queue ของ delayed job (accept/scan timeout, vendor confirm, mobile app notification)
const assignmentTimeoutQueue = new Queue(REDIS_CONFIG.assignmentTimeoutQueueName, {
  connection: bullProducerConnection,
});

// Config queue ของ delayed job กลับจากพักและจบกะ
const workerBreakReturnQueue = new Queue(REDIS_CONFIG.workerBreakReturnQueueName, {
  connection: bullProducerConnection,
});

// Config retry ของ timeout job ที่ถ้าพลาดแล้วสถานะจะค้าง (accept/scan/vendor confirm)
const ASSIGNMENT_TIMEOUT_RETRY_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 1000 },
} as const;

// Config BullMQ worker ของแต่ละ queue
let timeoutWorker: Worker | null = null;
let breakReturnWorker: Worker | null = null;

// Config score ล่าสุดของคิว (ต่อท้ายคิว และแทรกหน้าคิวด้วยค่าติดลบ)
let lastWorkerQueueScore = 0;
let lastWorkerQueueFrontScore = 0;

/* -------------------------------------- Functions -------------------------------------- */

// Function ลบ delayed job ถ้ามี (ลบ job ที่กำลังทำงานไม่ได้จะไม่ throw เพราะ job เช็คสถานะเองอยู่แล้ว)
async function removeQueueJobIfPresent(queue: Queue, jobId: string): Promise<void> {
  const job = await queue.getJob(jobId);

  if (!job) {
    return;
  }

  try {
    await job.remove();
  } catch (error) {
    logger.warn("Skipped removing a queue job that could not be removed (likely being processed).", {
      queue: queue.name,
      jobId,
      error,
    });
  }
}

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

// Function แปลงผล HGETALL จาก Lua (array สลับ field/value) เป็น object
function toHashRecord(values: string[]): Record<string, string> {
  const record: Record<string, string> = {};

  for (let index = 0; index + 1 < values.length; index += 2) {
    record[values[index]] = values[index + 1];
  }

  return record;
}

// Function บันทึกสถานะ worker พร้อมเพิ่มเข้า/ลบออกจาก ready queue แบบ atomic (queueScore = null คือลบออก)
async function setWorkerQueueState(
  accountId: number,
  status: WorkerWorkStatus,
  options: {
    readyAt?: Date | null;
    breakUntil?: Date | null;
    openAppReason?: string | null;
    queueScore: number | null;
  }
): Promise<WorkerQueueEntryDto> {
  const latest = await redis.setWorkerQueueState(
    buildWorkerStatusKey(accountId),
    REDIS_CONFIG.workerQueueKey,
    String(accountId),
    status,
    options.readyAt ? options.readyAt.toISOString() : "",
    options.breakUntil ? options.breakUntil.toISOString() : "",
    // open_app_reason มีค่าเฉพาะสถานะ OPEN_APP
    status === WORKER_WORK_STATUS.OPEN_APP ? options.openAppReason || "" : "",
    new Date().toISOString(),
    options.queueScore === null ? "" : String(options.queueScore)
  );

  return mapQueueStatus(accountId, toHashRecord(latest)) as WorkerQueueEntryDto;
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

  return setWorkerQueueState(accountId, WORKER_WORK_STATUS.READY, {
    readyAt: new Date(readyScore),
    queueScore: readyScore,
  });
}

// Function จอง score สำหรับแทรกหน้าคิว (ต่ำกว่า score ต่ำสุดใน Redis เสมอ แม้ server restart)
async function reserveWorkerQueueFrontScores(count: number): Promise<number> {
  const lowest = await redis.zrange(REDIS_CONFIG.workerQueueKey, 0, "0", "WITHSCORES");
  const lowestScore = lowest.length >= 2 ? Number(lowest[1]) : 0;
  // อ่าน lastWorkerQueueFrontScore หลัง await เสมอ กันสองคำขอพร้อมกันใน process เดียวได้ score ชุดเดียวกัน
  const base = Math.min(
    lastWorkerQueueFrontScore,
    Number.isFinite(lowestScore) ? lowestScore : 0,
    0
  );

  lastWorkerQueueFrontScore = base - count;
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

  const firstScore = await reserveWorkerQueueFrontScores(uniqueAccountIds.length);
  const readyAt = new Date();
  const entries: WorkerQueueEntryDto[] = [];

  for (const [index, accountId] of uniqueAccountIds.entries()) {
    entries.push(
      await setWorkerQueueState(accountId, WORKER_WORK_STATUS.READY, {
        readyAt,
        queueScore: firstScore + index,
      })
    );
  }

  return entries;
}

// Function ย้าย worker ออกจากคิวเป็น open_app พร้อมเหตุผล (ถ้ามี)
export async function markWorkerOpenApp(
  accountId: number,
  reason?: string
): Promise<WorkerQueueEntryDto> {
  return setWorkerQueueState(accountId, WORKER_WORK_STATUS.OPEN_APP, {
    openAppReason: reason,
    queueScore: null,
  });
}

// Function อัปเดตสถานะ worker assigned ใน Redis/BullMQ queue
export async function markWorkerAssigned(accountId: number): Promise<WorkerQueueEntryDto> {
  return setWorkerQueueState(accountId, WORKER_WORK_STATUS.ASSIGNED, { queueScore: null });
}

// Function อัปเดตสถานะ worker break ใน Redis/BullMQ queue
export async function markWorkerBreak(
  accountId: number,
  breakUntil: Date
): Promise<WorkerQueueEntryDto> {
  return setWorkerQueueState(accountId, WORKER_WORK_STATUS.BREAK, {
    breakUntil,
    queueScore: null,
  });
}

// Function ดึง worker ออกจาก ready queue แบบ atomic (คืน false ถ้าไม่อยู่ในคิวแล้ว)
export async function claimWorkerFromReadyQueue(accountId: number): Promise<boolean> {
  const removed = await redis.zrem(REDIS_CONFIG.workerQueueKey, String(accountId));

  return removed === 1;
}

// Function ดึง worker ที่ Admin เลือกออกจากคิวพร้อมเปลี่ยนเป็น assigned ในคำสั่งเดียว (กันชนกับ dispatch)
export async function claimReadyWorkerForAssignment(accountId: number): Promise<boolean> {
  const claimed = await redis.claimReadyWorkerAtomic(
    buildWorkerStatusKey(accountId),
    REDIS_CONFIG.workerQueueKey,
    String(accountId),
    WORKER_WORK_STATUS.READY,
    WORKER_WORK_STATUS.ASSIGNED,
    new Date().toISOString()
  );

  return Number(claimed) === 1;
}

// Function นับจำนวน worker ที่รออยู่ใน ready queue
export async function countReadyWorkers(): Promise<number> {
  return redis.zcard(REDIS_CONFIG.workerQueueKey);
}

// Function pop ready workers จาก Redis FIFO แบบ atomic (pop พร้อมเปลี่ยนเป็น assigned ในคำสั่งเดียว)
export async function popReadyWorkers(limit: number): Promise<WorkerQueueEntryDto[]> {
  if (limit <= 0) {
    return [];
  }

  const accountIds = await redis.popReadyWorkersAtomic(
    REDIS_CONFIG.workerQueueKey,
    REDIS_CONFIG.workerStatusKeyPrefix,
    String(limit),
    WORKER_WORK_STATUS.READY,
    WORKER_WORK_STATUS.ASSIGNED,
    new Date().toISOString()
  );
  const statuses = await getWorkerQueueStatuses(accountIds.map(Number));

  return accountIds
    .map((accountId) => statuses.get(Number(accountId)))
    .filter((entry): entry is WorkerQueueEntryDto => Boolean(entry));
}

// Function ตรวจว่า worker อยู่ใน ready queue จริงหรือไม่ (สถานะ ready อย่างเดียวไม่พอ)
export async function isWorkerInReadyQueue(accountId: number): Promise<boolean> {
  return (await redis.zscore(REDIS_CONFIG.workerQueueKey, String(accountId))) !== null;
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

// Function บันทึก heartbeat ของ worker (session_started_at เปลี่ยนเฉพาะตอนกลับมา online จาก offline)
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

// Function ล้าง presence ของ worker ทันทีเมื่อ session ถูก revoke
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

// Function ตั้ง marker รอพา worker กลับเข้าคิวหลังพักเมื่อต่อ socket กลับมา (หมดอายุตามเวลาที่ให้ retry)
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
  await removeQueueJobIfPresent(assignmentTimeoutQueue, `assignment-timeout-${assignmentId}`);
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
  await removeQueueJobIfPresent(assignmentTimeoutQueue, `assignment-scan-timeout-${assignmentId}`);
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
  await removeQueueJobIfPresent(assignmentTimeoutQueue, `assignment-scan-warning-${assignmentId}`);
}

// Function ตั้งเวลา delayed job vendor confirmation timeout ใน Redis/BullMQ queue
export async function scheduleVendorConfirmationTimeout(
  ticketId: number,
  submissionId: number,
  deadlineMs: number
): Promise<void> {
  await removeVendorConfirmationTimeout(ticketId, submissionId);
  await assignmentTimeoutQueue.add(
    "vendor-confirm-timeout",
    {
      ticketId,
      submissionId,
      deadlineMs,
      kind: "vendor_confirm",
    },
    {
      delay: Math.max(0, deadlineMs - Date.now()),
      jobId: `vendor-confirm-timeout-${ticketId}-${submissionId}`,
      removeOnComplete: true,
      removeOnFail: 100,
      // retry เพราะเป็นทางเดียวที่ auto-confirm แผง ถ้าพลาดแผงจะค้าง DELIVERED
      ...ASSIGNMENT_TIMEOUT_RETRY_OPTIONS,
    }
  );
}

// Function ลบ vendor confirmation timeout ใน Redis/BullMQ queue
export async function removeVendorConfirmationTimeout(
  ticketId: number,
  submissionId: number
): Promise<void> {
  await removeQueueJobIfPresent(assignmentTimeoutQueue, `vendor-confirm-timeout-${ticketId}-${submissionId}`);
}

// Function ตรวจว่ามี vendor confirm timeout job ที่ยังรออยู่ (job ที่ failed ไม่นับและถูกลบทิ้ง)
export async function hasVendorConfirmationTimeout(
  ticketId: number,
  submissionId: number
): Promise<boolean> {
  const jobId = `vendor-confirm-timeout-${ticketId}-${submissionId}`;
  const job = await assignmentTimeoutQueue.getJob(jobId);

  if (!job) {
    return false;
  }

  if ((await job.getState()) === "failed") {
    await removeQueueJobIfPresent(assignmentTimeoutQueue, jobId);
    return false;
  }

  return true;
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
  await removeQueueJobIfPresent(assignmentTimeoutQueue, `mobile-app-release-notification-${mobileAppVersionId}`);
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
  await removeQueueJobIfPresent(assignmentTimeoutQueue, `mobile-app-force-update-notification-${mobileAppVersionId}`);
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
      // ต้องชื่อ workerId ให้ตรงกับฝั่งที่อ่าน job ใน worker-dispatch.ts
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
      // key ต้องชื่อ workerId เหตุผลเดียวกับ scheduleWorkerBreakReturn ด้านบน (ไม่งั้น auto-eject ตอนหมดกะไม่ทำงาน)
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
  await removeQueueJobIfPresent(workerBreakReturnQueue, `worker-shift-end-${accountId}-${scheduleId}`);
}

// Function ลบ worker break return ใน Redis/BullMQ queue
export async function removeWorkerBreakReturn(
  accountId: number,
  scheduleId: number
): Promise<void> {
  await removeQueueJobIfPresent(workerBreakReturnQueue, `worker-break-return-${accountId}-${scheduleId}`);
}

// Function ตั้ง job แจ้งเตือนเมื่อหมดเวลารอ worker ต่อ socket กลับหลังพัก (เวลาเดียวกับ marker)
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

// Function ลบ job แจ้งเตือนหมดเวลารอหลังพัก (worker ต่อ socket กลับมาทันแล้ว)
export async function removeWorkerBreakRetryExpiry(
  workerId: number,
  scheduleId: number
): Promise<void> {
  await removeQueueJobIfPresent(workerBreakReturnQueue, `worker-break-retry-expired-${workerId}-${scheduleId}`);
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
    async (job: Job<AssignmentTimeoutJobData>) =>
      runWithLogContext({ jobName: REDIS_CONFIG.assignmentTimeoutQueueName, jobId: job.id }, () => handler(job.data)),
    {
      connection: bullWorkerConnection,
    }
  );

  timeoutWorker.on("failed", (job, error) => {
    logger.error("Assignment timeout job failed.", {
      jobName: REDIS_CONFIG.assignmentTimeoutQueueName,
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
    async (job: Job<WorkerScheduleJobData>) =>
      runWithLogContext({ jobName: REDIS_CONFIG.workerBreakReturnQueueName, jobId: job.id }, () => handler(job.data)),
    {
      connection: bullWorkerConnection,
    }
  );

  breakReturnWorker.on("failed", (job, error) => {
    logger.error("Worker break return job failed.", { jobName: REDIS_CONFIG.workerBreakReturnQueueName, jobId: job?.id, error });
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
}
