// Import Library
import IORedis from "ioredis";
// Import Config
import { REDIS_CONFIG } from "../config/redis.config";
import { getPrisma } from "../db/prisma";
// Import Runtime
import { isReadinessShuttingDown } from "../runtime/readiness-state";
// Import Utils
import { logger } from "../utils/logger";

/* -------------------------------------- Types -------------------------------------- */

// Type ผลตรวจ dependency หนึ่งตัว
type ReadinessCheck = {
  status: "ok" | "error";
};

// Type ผลตรวจความพร้อมทั้งระบบ
type ReadinessResult = {
  status: "ready" | "not_ready";
  checks: {
    database: ReadinessCheck;
    redis: ReadinessCheck;
  };
};

/* -------------------------------------- Functions -------------------------------------- */

// Function ตรวจว่า database พร้อมใช้งาน
async function checkDatabaseReady(): Promise<ReadinessCheck> {
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    return { status: "ok" };
  } catch (error) {
    logger.error("Readiness database check failed.", { error });
    return {
      status: "error",
    };
  }
}

// Config Redis client เดียวที่ใช้ซ้ำทุกครั้งที่เรียก /ready
let healthRedisClient: IORedis | null = null;

// Function ดึง Redis client สำหรับ health check (สร้างครั้งแรกครั้งเดียว)
function getHealthRedisClient(): IORedis {
  if (!healthRedisClient) {
    healthRedisClient = new IORedis(REDIS_CONFIG.url, {
      maxRetriesPerRequest: 1,
      protocol: 2,
      lazyConnect: true,
    });
    healthRedisClient.on("error", (error) => {
      logger.error("Readiness Redis client connection error.", { error });
    });
  }

  return healthRedisClient;
}

// Function ตรวจว่า Redis พร้อมใช้งาน
async function checkRedisReady(): Promise<ReadinessCheck> {
  try {
    const redis = getHealthRedisClient();

    if (redis.status !== "ready" && redis.status !== "connecting") {
      try {
        await redis.connect();
      } catch (connectError) {
        // Request อื่นอาจเริ่ม connect() ไปพร้อมกันแล้ว (race condition) — ไม่ต้อง fail ทั้ง check ถ้าเจอ error นี้
        const isAlreadyConnecting =
          connectError instanceof Error &&
          connectError.message === "Redis is already connecting/connected";

        if (!isAlreadyConnecting) {
          throw connectError;
        }
      }
    }

    await redis.ping();
    return { status: "ok" };
  } catch (error) {
    logger.error("Readiness Redis check failed.", { error });
    return {
      status: "error",
    };
  }
}

// Function ปิด Redis Client ที่ใช้ตรวจ Readiness สำหรับ Graceful Shutdown หรือ Test
export async function closeHealthCheckRedisConnections(): Promise<void> {
  if (!healthRedisClient) {
    return;
  }

  const client = healthRedisClient;
  healthRedisClient = null;

  if (client.status !== "end") {
    await client.quit().catch(() => undefined);
  }
}

// Function ตรวจความพร้อมของระบบ (database + redis) สำหรับ endpoint /ready
export async function checkReadiness(): Promise<ReadinessResult> {
  if (isReadinessShuttingDown()) {
    return {
      status: "not_ready",
      checks: {
        database: { status: "error" },
        redis: { status: "error" },
      },
    };
  }

  const [database, redis] = await Promise.all([
    checkDatabaseReady(),
    checkRedisReady(),
  ]);
  const ready = database.status === "ok" && redis.status === "ok";

  return {
    status: ready ? "ready" : "not_ready",
    checks: {
      database,
      redis,
    },
  };
}
