// Import Library
import { Queue, Worker, type Job } from "bullmq";
import type { Prisma } from "@prisma/client";
// Import Config
import { buildBullConnection, REDIS_CONFIG } from "../config/redis.config";
// Import Utils
import { logger } from "../utils/logger";
// Import Repositories
import * as messageDeliveryLogRepository from "../repositories/shared/message-delivery-log.repository";
// Import Types
import type { LineMessage, LineMessageJobData } from "../types/line.type";

/* -------------------------------------- Config -------------------------------------- */

// สร้าง connection สำหรับ BullMQ queue
const bullConnection = buildBullConnection();

// สร้าง queue สำหรับ LINE message
const lineMessageQueue = new Queue(REDIS_CONFIG.lineMessageQueueName, {
  connection: bullConnection,
});

// สร้าง worker สำหรับ LINE message queue
let lineWorker: Worker | null = null;

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
    },
    body: JSON.stringify({
      to: data.to,
      messages: data.messages,
    }),
  });

  // Throw error ถ้า LINE Messaging API ส่ง response ไม่สำเร็จ
  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(`LINE push failed with ${response.status}: ${responseText}`);
  }
}

// Function เพิ่มงานเข้า queue LINE message ใน Redis/BullMQ queue
export async function enqueueLineMessage(
  jobName: string,
  data: LineMessageJobData
): Promise<void> {
  await lineMessageQueue.add(jobName, data, {
    removeOnComplete: true,
    removeOnFail: 100,
  });
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
    async (job: Job<LineMessageJobData>) => {
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
    },
    {
      connection: bullConnection,
    }
  );

  // Log error ถ้าเกิด error ใน worker
  lineWorker.on("failed", (_job, error) => {
    logger.error("LINE message job failed.", { error });
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
