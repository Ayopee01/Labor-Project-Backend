/* -------------------------------------- Config -------------------------------------- */

// Config สำหรับ Redis และ BullMQ — อ่านค่าจาก env
export const REDIS_CONFIG = {
  url: requiredEnv("REDIS_URL"),
  workerQueueKey: requiredEnv("REDIS_WORKER_QUEUE_KEY"),
  workerStatusKeyPrefix: requiredEnv("REDIS_WORKER_STATUS_KEY_PREFIX"),
  workerPresenceKeyPrefix: requiredEnv("REDIS_WORKER_PRESENCE_KEY_PREFIX"),
  workerPresenceStaleSeconds: requiredNumberEnv("WORKER_PRESENCE_STALE_SECONDS"),
  workerBreakCountKeyPrefix: requiredEnv("REDIS_WORKER_BREAK_COUNT_KEY_PREFIX"),
  assignmentTimeoutQueueName: requiredEnv("BULLMQ_ASSIGNMENT_TIMEOUT_QUEUE"),
  workerBreakReturnQueueName: requiredEnv("BULLMQ_WORKER_BREAK_RETURN_QUEUE"),
  lineMessageQueueName: requiredEnv("BULLMQ_LINE_MESSAGE_QUEUE"),
} as const;

/* -------------------------------------- Validation -------------------------------------- */

assertDistinctValues(
  "REDIS_WORKER_QUEUE_KEY, REDIS_WORKER_STATUS_KEY_PREFIX, REDIS_WORKER_PRESENCE_KEY_PREFIX, REDIS_WORKER_BREAK_COUNT_KEY_PREFIX",
  [
    REDIS_CONFIG.workerQueueKey,
    REDIS_CONFIG.workerStatusKeyPrefix,
    REDIS_CONFIG.workerPresenceKeyPrefix,
    REDIS_CONFIG.workerBreakCountKeyPrefix,
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

// Function อ่านค่า env ที่ต้องมี ถ้าไม่มีให้ Throw Error ทันที
function requiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

// Function อ่านค่า env ที่ต้องมีและแปลงเป็นตัวเลข ถ้าไม่ใช่ตัวเลขให้ Throw Error
function requiredNumberEnv(name: string): number {
  const value = requiredEnv(name);
  const numberValue = Number(value);

  if (Number.isNaN(numberValue)) {
    throw new Error(`${name} must be a valid number`);
  }

  return numberValue;
}

// Function เช็คว่าค่า env ไม่ซ้ำกัน ถ้าซ้ำให้ Throw Error
function assertDistinctValues(label: string, values: string[]): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must each be set to a distinct value.`);
  }
}

// Function สร้าง BullMQ connection options จาก REDIS_CONFIG.url — ใช้ร่วมกันทุก queue ในโปรเจกต์
export function buildBullConnection() {
  const redisUrl = new URL(REDIS_CONFIG.url);
  // rediss:// หมายถึง Redis บังคับ TLS — ต้องส่ง tls option ให้ BullMQ เอง ไม่งั้นต่อแบบ plain TCP
  // เข้า port ที่รอ TLS handshake แล้วต่อไม่ติดเงียบๆ
  const isTls = redisUrl.protocol === "rediss:";

  return {
    host: redisUrl.hostname,
    port: Number(redisUrl.port || 6379),
    username: redisUrl.username || undefined,
    password: redisUrl.password || undefined,
    db: redisUrl.pathname ? Number(redisUrl.pathname.replace("/", "") || 0) : 0,
    maxRetriesPerRequest: null,
    ...(isTls ? { tls: {} } : {}),
  };
}



