// Import Library
import { randomUUID } from "crypto";
import { Queue, UnrecoverableError, Worker, type Job } from "bullmq";
import type { Prisma } from "@prisma/client";
// Import Config
import { buildBullConnection, REDIS_CONFIG } from "../config/redis.config";
// Import Repositories
import * as messageDeliveryLogRepository from "../repositories/shared/message-delivery-log.repository";
// Import Types
import type { LineMessage, LineMessageJobData } from "../types/line.type";
// Import Utils
import { runWithLogContext } from "../utils/log-context";
import { logger } from "../utils/logger";

/* -------------------------------------- Config -------------------------------------- */

// สร้าง connection สำหรับ BullMQ worker และ queue ที่เพิ่ม job จาก request (ล้มเร็ว)
const bullConnection = buildBullConnection();
const bullProducerConnection = buildBullConnection("producer");

// สร้าง queue สำหรับ LINE message
const lineMessageQueue = new Queue(REDIS_CONFIG.lineMessageQueueName, {
  connection: bullProducerConnection,
});

// สร้าง worker สำหรับ LINE message queue
let lineWorker: Worker | null = null;

// Config timeout ของ request ไป LINE API (กัน request ค้างทำให้คิวข้อความค้างทั้งหมด)
const LINE_API_TIMEOUT_MS = 10_000;

// Config retry ของ LINE push (ส่งซ้ำได้ปลอดภัยเพราะใช้ retry key เดิม)
const LINE_PUSH_RETRY_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5000 },
} as const;

// Config endpoint ดูโควต้าข้อความรายเดือนของ LINE OA และจำนวนที่ใช้ไปแล้ว
const LINE_QUOTA_URL = "https://api.line.me/v2/bot/message/quota";
const LINE_QUOTA_CONSUMPTION_URL = "https://api.line.me/v2/bot/message/quota/consumption";

// Config ข้อความใน response 429 ที่แปลว่าโควต้ารายเดือนหมด (ต่างจาก 429 rate limit ชั่วคราว)
const LINE_MONTHLY_LIMIT_PATTERN = /monthly limit/i;

// Config เกณฑ์เตือนโควต้า LINE (เรียงจากมากไปน้อย ใช้เกณฑ์แรกที่ถึง)
const LINE_QUOTA_ALERT_THRESHOLDS = [
  { percent: 95, alertCode: "LINE_QUOTA_CRITICAL", message: "LINE monthly message quota is nearly exhausted." },
  { percent: 80, alertCode: "LINE_QUOTA_LOW", message: "LINE monthly message quota is running low." },
] as const;

// Class error เมื่อโควต้าข้อความรายเดือนหมด (UnrecoverableError = BullMQ ไม่ retry เพราะส่งซ้ำก็ไม่ผ่านจนกว่าจะเติมโควต้า)
export class LineQuotaExhaustedError extends UnrecoverableError {
  constructor(message: string) {
    super(message);
    this.name = "LineQuotaExhaustedError";
  }
}

/* -------------------------------------- Functions -------------------------------------- */

// Function ส่ง LINE push message ผ่าน LINE Messaging API
async function sendLinePushMessage(data: LineMessageJobData): Promise<void> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;

  // Throw error ถ้าไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN ใน env
  if (!token) {
    throw new Error(
      "LINE_CHANNEL_ACCESS_TOKEN is required for LINE push delivery."
    );
  }

  // ส่ง request ไปยัง LINE Messaging API
  const response = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(data.retry_key && { "X-Line-Retry-Key": data.retry_key }),
    },
    body: JSON.stringify({
      to: data.to,
      messages: data.messages,
    }),
    signal: AbortSignal.timeout(LINE_API_TIMEOUT_MS),
  });

  // 409 พร้อม retry key = LINE รับข้อความจากรอบก่อนแล้ว ถือว่าสำเร็จ
  if (response.status === 409 && data.retry_key) {
    return;
  }

  // Throw error ถ้า LINE Messaging API ส่ง response ไม่สำเร็จ
  if (!response.ok) {
    const responseText = await response.text();
    const message = `LINE push failed with ${response.status}: ${responseText}`;

    if (response.status === 429 && LINE_MONTHLY_LIMIT_PATTERN.test(responseText)) {
      throw new LineQuotaExhaustedError(message);
    }

    throw new Error(message);
  }
}

// Function เรียก LINE API แบบ GET แล้วคืน JSON
async function fetchLineApiJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(LINE_API_TIMEOUT_MS),
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(`LINE quota request failed with ${response.status}: ${responseText}`);
  }

  return (await response.json()) as T;
}

// Function เช็คโควต้าข้อความรายเดือนของ LINE แล้วส่ง error เข้า Sentry เมื่อใช้ถึงเกณฑ์ (เตือนก่อนโควต้าหมด)
export async function checkLineMessageQuota(): Promise<void> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;

  // ยังไม่ตั้งค่า LINE = ไม่มีโควต้าให้เช็ค
  if (!token) {
    return;
  }

  const [quota, consumption] = await Promise.all([
    fetchLineApiJson<{ type: "none" | "limited"; value?: number }>(LINE_QUOTA_URL, token),
    fetchLineApiJson<{ totalUsage: number }>(LINE_QUOTA_CONSUMPTION_URL, token),
  ]);

  // แพ็กเกจที่ไม่จำกัดจำนวนข้อความไม่ต้องเตือน
  if (quota.type !== "limited" || !quota.value) {
    return;
  }

  const percent = Math.floor((consumption.totalUsage / quota.value) * 100);
  const threshold = LINE_QUOTA_ALERT_THRESHOLDS.find((item) => percent >= item.percent);

  if (!threshold) {
    return;
  }

  logger.error(threshold.message, {
    alertCode: threshold.alertCode,
    used: consumption.totalUsage,
    limit: quota.value,
    percent,
  });
}

// Function ส่ง LINE reply message ทันทีด้วย replyToken (ไม่ผ่านคิว เพราะ token หมดอายุไว)
export async function sendLineReplyMessage(
  replyToken: string,
  messages: LineMessage[]
): Promise<void> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;

  if (!token) {
    throw new Error(
      "LINE_CHANNEL_ACCESS_TOKEN is required for LINE reply delivery."
    );
  }

  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      replyToken,
      messages,
    }),
    signal: AbortSignal.timeout(LINE_API_TIMEOUT_MS),
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(`LINE reply failed with ${response.status}: ${responseText}`);
  }
}

// Function เพิ่มงานเข้า queue LINE message ใน Redis/BullMQ queue
export async function enqueueLineMessage(
  jobName: string,
  data: LineMessageJobData
): Promise<void> {
  await lineMessageQueue.add(
    jobName,
    {
      ...data,
      retry_key: data.retry_key ?? randomUUID(),
    },
    {
      removeOnComplete: true,
      removeOnFail: 100,
      ...LINE_PUSH_RETRY_OPTIONS,
    }
  );
}

// Function สร้าง log การส่ง LINE และนำข้อความเข้า queue
export async function enqueueLoggedLineMessage(input: {
  jobName: string;
  action: string;
  targetLineUserId: string;
  payload: unknown;
  messages: LineMessage[];
}): Promise<number> {
  const logId = await messageDeliveryLogRepository.createMessageDeliveryLog(
    "LINE",
    input.action,
    input.payload as Prisma.InputJsonValue,
    input.targetLineUserId
  );

  await enqueueLineMessage(input.jobName, {
    log_id: logId,
    to: input.targetLineUserId,
    messages: input.messages,
  });

  return logId;
}

// Function เริ่ม notification workers ใน Redis/BullMQ queue
export function startLineMessageWorker(): void {
  if (lineWorker) {
    return;
  }

  // สร้าง worker สำหรับ LINE message queue
  lineWorker = new Worker(
    REDIS_CONFIG.lineMessageQueueName,
    async (job: Job<LineMessageJobData>) => runWithLogContext({ jobName: REDIS_CONFIG.lineMessageQueueName, jobId: job.id }, async () => {
      try {
        await sendLinePushMessage(job.data);
        await messageDeliveryLogRepository.updateMessageDeliveryLogStatus(
          job.data.log_id,
          messageDeliveryLogRepository.MESSAGE_DELIVERY_STATUS.SENT
        );
      } catch (error) {
        await messageDeliveryLogRepository.updateMessageDeliveryLogStatus(
          job.data.log_id,
          messageDeliveryLogRepository.MESSAGE_DELIVERY_STATUS.FAILED,
          error instanceof Error ? error.message : String(error)
        );
        throw error;
      }
    }),
    {
      connection: bullConnection,
    }
  );

  // Log error ถ้าเกิด error ใน worker (โควต้าหมดแยกเป็นข้อความของตัวเอง ให้ Sentry เปิดเป็น issue แยกจาก error อื่น)
  lineWorker.on("failed", (job, error) => {
    if (error instanceof LineQuotaExhaustedError) {
      logger.error("LINE monthly message quota exhausted.", {
        jobName: REDIS_CONFIG.lineMessageQueueName,
        jobId: job?.id,
        alertCode: "LINE_QUOTA_EXHAUSTED",
      });
      return;
    }

    logger.error("LINE message job failed.", { jobName: REDIS_CONFIG.lineMessageQueueName, jobId: job?.id, error });
  });
}

// Function ปิด BullMQ LINE queue connection สำหรับ graceful shutdown
export async function closeLineMessageQueueConnections(): Promise<void> {
  if (lineWorker) {
    await lineWorker.close();
    lineWorker = null;
  }

  await lineMessageQueue.close();
}
