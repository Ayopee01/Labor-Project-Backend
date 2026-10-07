// Import Config
import { readRequiredEnv } from "./env";

/* -------------------------------------- Config -------------------------------------- */

// Config สำหรับ Redis และ BullMQ — อ่านค่าจาก env
export const REDIS_CONFIG = {
  url: readRequiredEnv("REDIS_URL"),
  workerQueueKey: readRequiredEnv("REDIS_WORKER_QUEUE_KEY"),
  workerStatusKeyPrefix: readRequiredEnv("REDIS_WORKER_STATUS_KEY_PREFIX"),
  workerPresenceKeyPrefix: readRequiredEnv("REDIS_WORKER_PRESENCE_KEY_PREFIX"),
  workerBreakCountKeyPrefix: readRequiredEnv("REDIS_WORKER_BREAK_COUNT_KEY_PREFIX"),
  workerBreakRetryKeyPrefix: readRequiredEnv("REDIS_WORKER_BREAK_RETRY_KEY_PREFIX"),
  assignmentTimeoutQueueName: readRequiredEnv("BULLMQ_ASSIGNMENT_TIMEOUT_QUEUE"),
  workerBreakReturnQueueName: readRequiredEnv("BULLMQ_WORKER_BREAK_RETURN_QUEUE"),
  lineMessageQueueName: readRequiredEnv("BULLMQ_LINE_MESSAGE_QUEUE"),
} as const;

// Config ให้คำสั่ง Redis ของ request ล้มเร็วเมื่อ Redis ล่ม แทนที่จะค้างรอเชื่อมต่อใหม่ไม่มีกำหนด
export const REDIS_FAIL_FAST_OPTIONS = {
  maxRetriesPerRequest: 2,
  commandTimeout: 5000,
} as const;

/* -------------------------------------- Validation -------------------------------------- */

assertDistinctValues(
  "REDIS_WORKER_QUEUE_KEY, REDIS_WORKER_STATUS_KEY_PREFIX, REDIS_WORKER_PRESENCE_KEY_PREFIX, REDIS_WORKER_BREAK_COUNT_KEY_PREFIX, REDIS_WORKER_BREAK_RETRY_KEY_PREFIX",
  [
    REDIS_CONFIG.workerQueueKey,
    REDIS_CONFIG.workerStatusKeyPrefix,
    REDIS_CONFIG.workerPresenceKeyPrefix,
    REDIS_CONFIG.workerBreakCountKeyPrefix,
    REDIS_CONFIG.workerBreakRetryKeyPrefix,
  ]
);
assertDistinctValues(
  "BULLMQ_ASSIGNMENT_TIMEOUT_QUEUE, BULLMQ_WORKER_BREAK_RETURN_QUEUE, BULLMQ_LINE_MESSAGE_QUEUE",
  [
    REDIS_CONFIG.assignmentTimeoutQueueName,
    REDIS_CONFIG.workerBreakReturnQueueName,
    REDIS_CONFIG.lineMessageQueueName,
  ]
);

/* -------------------------------------- Functions -------------------------------------- */

// Function เช็คว่าค่า env ไม่ซ้ำกัน ถ้าซ้ำให้ Throw Error
function assertDistinctValues(label: string, values: string[]): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must each be set to a distinct value.`);
  }
}

// Function สร้าง BullMQ connection options (worker ต้องรอต่อใหม่ได้ไม่จำกัด ส่วน producer ล้มเร็ว)
export function buildBullConnection(role: "worker" | "producer" = "worker") {
  const redisUrl = new URL(REDIS_CONFIG.url);
  // rediss:// ต้องส่ง tls option ให้ BullMQ เอง ไม่งั้นต่อไม่ติดแบบเงียบๆ
  const isTls = redisUrl.protocol === "rediss:";

  return {
    host: redisUrl.hostname,
    port: Number(redisUrl.port || 6379),
    // URL เก็บ username/password แบบ percent-encoded ต้อง decode ก่อน ไม่งั้นรหัสที่มีอักขระพิเศษจะ AUTH ไม่ผ่าน
    username: redisUrl.username ? decodeURIComponent(redisUrl.username) : undefined,
    password: redisUrl.password ? decodeURIComponent(redisUrl.password) : undefined,
    db: redisUrl.pathname ? Number(redisUrl.pathname.replace("/", "") || 0) : 0,
    ...(role === "worker" ? { maxRetriesPerRequest: null } : REDIS_FAIL_FAST_OPTIONS),
    // ioredis v6 ใช้ RESP3 เป็น default — ล็อก RESP2 ไว้ให้ BullMQ ทำงานแบบเดิม
    protocol: 2 as const,
    ...(isTls ? { tls: {} } : {}),
  };
}



