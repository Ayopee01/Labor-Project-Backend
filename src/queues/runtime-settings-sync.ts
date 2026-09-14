// Import Library
import IORedis from "ioredis";
// Import Config
import { REDIS_CONFIG } from "../config/redis.config";
// Import Services
import { clearRuntimeSettingsCache } from "../services/shared/runtime-settings.service";
// Import Utils
import { logger } from "../utils/logger";

/* -------------------------------------- Config -------------------------------------- */

// สร้างตัวแปรสำหรับ channel ของ runtime settings invalidation
const RUNTIME_SETTINGS_INVALIDATION_CHANNEL = "runtime_settings:invalidate";

// สร้าง Redis publisher สำหรับ runtime settings invalidation
const publisher = new IORedis(REDIS_CONFIG.url, {
  maxRetriesPerRequest: null,
});

// สร้าง Redis subscriber สำหรับ runtime settings invalidation
let subscriber: IORedis | null = null;

/* -------------------------------------- Functions -------------------------------------- */

// Function แจ้งทุก instance ให้ล้าง runtime settings cache
export async function publishRuntimeSettingsInvalidation(): Promise<void> {
  await publisher.publish(RUNTIME_SETTINGS_INVALIDATION_CHANNEL, "1");
}

// Function เริ่ม subscribe ฟัง runtime settings invalidation จาก instance อื่น (เรียกครั้งเดียวตอน process start)
export function startRuntimeSettingsSync(): void {
  if (subscriber) {
    return;
  }

  subscriber = new IORedis(REDIS_CONFIG.url, {
    maxRetriesPerRequest: null,
  });

  subscriber.on("error", (error) => {
    logger.error("Runtime settings sync subscriber connection error.", { error });
  });

  subscriber.on("message", (channel: string) => {
    if (channel === RUNTIME_SETTINGS_INVALIDATION_CHANNEL) {
      clearRuntimeSettingsCache();
    }
  });

  subscriber.subscribe(RUNTIME_SETTINGS_INVALIDATION_CHANNEL).catch((error) => {
    logger.error(
      "Failed to subscribe to runtime settings invalidation channel.",
      { error },
    );
  });
}

// Function ปิด Redis connections ของ runtime settings sync สำหรับ graceful shutdown
export async function closeRuntimeSettingsSyncConnections(): Promise<void> {
  if (subscriber && subscriber.status !== "end") {
    await subscriber.quit();
  }

  subscriber = null;

  if (publisher.status !== "end") {
    await publisher.quit();
  }
}
