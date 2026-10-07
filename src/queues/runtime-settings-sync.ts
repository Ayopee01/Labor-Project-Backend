// Import Library
import IORedis from "ioredis";
// Import Config
import { REDIS_CONFIG } from "../config/redis.config";
// Import Services
import { clearRuntimeSettingsCache } from "../services/shared/runtime-settings.service";
// Import Utils
import { logger } from "../utils/logger";

/* -------------------------------------- Config -------------------------------------- */

// Config channel สำหรับแจ้งล้าง cache runtime settings
const RUNTIME_SETTINGS_INVALIDATION_CHANNEL = "runtime_settings:invalidate";

// Config Redis publisher สำหรับแจ้งล้าง cache
const publisher = new IORedis(REDIS_CONFIG.url, {
  maxRetriesPerRequest: null,
  protocol: 2,
});

// Config Redis subscriber สำหรับรับแจ้งล้าง cache
let subscriber: IORedis | null = null;

/* -------------------------------------- Functions -------------------------------------- */

// Function แจ้งทุก instance ให้ล้าง runtime settings cache
export async function publishRuntimeSettingsInvalidation(): Promise<void> {
  await publisher.publish(RUNTIME_SETTINGS_INVALIDATION_CHANNEL, "1");
}

// Function เริ่มรับแจ้งล้าง cache runtime settings จาก instance อื่น (เรียกตอน start)
export function startRuntimeSettingsSync(): void {
  if (subscriber) {
    return;
  }

  subscriber = new IORedis(REDIS_CONFIG.url, {
    maxRetriesPerRequest: null,
    protocol: 2,
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
