// Import Library
import IORedis from "ioredis";
// Import Config
import { buildBullConnection } from "../config/redis.config";

/* -------------------------------------- Config -------------------------------------- */

// Config Redis connection ที่ BullMQ worker ทุกตัวใช้ร่วมกัน (BullMQ แยก blocking connection ให้แต่ละ worker เอง)
export const bullWorkerConnection = new IORedis(buildBullConnection());

// Config Redis connection ที่ queue ฝั่งเพิ่ม job จาก request, คิว worker และ health check ใช้ร่วมกัน (ล้มเร็วเมื่อ Redis ล่ม request จะได้ไม่ค้าง)
export const bullProducerConnection = new IORedis(buildBullConnection("producer"));

/* -------------------------------------- Functions -------------------------------------- */

// Function ปิด Redis connection ที่ใช้ร่วมกัน สำหรับ graceful shutdown (เรียกหลังปิด queue/worker ทุกตัวแล้ว)
export async function closeBullConnections(): Promise<void> {
  for (const connection of [bullWorkerConnection, bullProducerConnection]) {
    if (connection.status !== "end") {
      await connection.quit();
    }
  }
}
