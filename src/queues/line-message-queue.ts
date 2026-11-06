// Import Library
import { randomUUID } from "crypto";
import { HTTPFetchError, messagingApi } from "@line/bot-sdk";
import { Queue, UnrecoverableError, Worker, type Job } from "bullmq";
import type { Prisma } from "@prisma/client";
// Import Config
import { REDIS_CONFIG } from "../config/redis.config";
// Import Queues
import { bullProducerConnection, bullWorkerConnection } from "./bull-connection";
// Import Repositories
import * as messageDeliveryLogRepository from "../repositories/shared/message-delivery-log.repository";
// Import Types
import type { LineMessage, LineMessageJobData } from "../types/line.type";
// Import Utils
import { runWithLogContext } from "../utils/log-context";
import { logger } from "../utils/logger";

/* -------------------------------------- Config -------------------------------------- */

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

// Function สร้าง client ของ LINE Messaging API จาก channel access token
function createLineClient(token: string): messagingApi.MessagingApiClient {
  return new messagingApi.MessagingApiClient({ channelAccessToken: token });
}

// Function รอ request ไป LINE API ไม่เกิน timeout (SDK ไม่รับ AbortSignal จึงตัดรอที่ฝั่งเรา กันคิวข้อความค้างทั้งหมด)
async function withLineApiTimeout<T>(request: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`LINE API request timed out after ${LINE_API_TIMEOUT_MS}ms`)), LINE_API_TIMEOUT_MS);
  });

  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Function ส่ง LINE push message ผ่าน LINE Messaging API
async function sendLinePushMessage(data: LineMessageJobData): Promise<void> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;

  // Throw error ถ้าไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN ใน env
  if (!token) {
    throw new Error(
      "LINE_CHANNEL_ACCESS_TOKEN is required for LINE push delivery."
    );
  }

  try {
    await withLineApiTimeout(
      createLineClient(token).pushMessage({ to: data.to, messages: data.messages }, data.retry_key)
    );
  } catch (error) {
    if (!(error instanceof HTTPFetchError)) {
      throw error;
    }

    // 409 พร้อม retry key = LINE รับข้อความจากรอบก่อนแล้ว ถือว่าสำเร็จ
    if (error.status === 409 && data.retry_key) {
      return;
    }

    const message = `LINE push failed with ${error.status}: ${error.body}`;

    if (error.status === 429 && LINE_MONTHLY_LIMIT_PATTERN.test(error.body)) {
      throw new LineQuotaExhaustedError(message);
    }

    throw new Error(message);
  }
}

// Function เรียก LINE API ดูโควต้า แล้วแปลง error ของ SDK เป็นข้อความที่อ่านง่าย
async function requestLineQuotaApi<T>(request: Promise<T>): Promise<T> {
  try {
    return await withLineApiTimeout(request);
  } catch (error) {
    if (error instanceof HTTPFetchError) {
      throw new Error(`LINE quota request failed with ${error.status}: ${error.body}`);
    }

    throw error;
  }
}

// Function เช็คโควต้าข้อความรายเดือนของ LINE แล้วส่ง error เข้า Sentry เมื่อใช้ถึงเกณฑ์ (เตือนก่อนโควต้าหมด)
export async function checkLineMessageQuota(): Promise<void> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;

  // ยังไม่ตั้งค่า LINE = ไม่มีโควต้าให้เช็ค
  if (!token) {
    return;
  }

  const client = createLineClient(token);
  const [quota, consumption] = await Promise.all([
    requestLineQuotaApi(client.getMessageQuota()),
    requestLineQuotaApi(client.getMessageQuotaConsumption()),
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

  try {
    await withLineApiTimeout(createLineClient(token).replyMessage({ replyToken, messages }));
  } catch (error) {
    if (error instanceof HTTPFetchError) {
      throw new Error(`LINE reply failed with ${error.status}: ${error.body}`);
    }

    throw error;
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
      connection: bullWorkerConnection,
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
