// Import Library
import IORedis from "ioredis";
// Import Config
import { REDIS_CONFIG } from "../config/redis.config";
import { getPrisma } from "../db/prisma";
// Import Utils
import { isReadinessShuttingDown } from "../runtime/readiness-state";
import { logger } from "../utils/logger";

type ReadinessCheck = {
  status: "ok" | "error";
};

type ReadinessResult = {
  status: "ready" | "not_ready";
  checks: {
    database: ReadinessCheck;
    redis: ReadinessCheck;
  };
};

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

// เก็บ Client เดียวไว้ใช้ซ้ำข้ามการ Poll แต่ละครั้ง กันสร้าง Connection ใหม่ทุกครั้งที่เรียก /ready ซึ่งสิ้นเปลืองโดยไม่จำเป็น
let healthRedisClient: IORedis | null = null;

function getHealthRedisClient(): IORedis {
  if (!healthRedisClient) {
    healthRedisClient = new IORedis(REDIS_CONFIG.url, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
    healthRedisClient.on("error", (error) => {
      logger.error("Readiness Redis client connection error.", { error });
    });
  }

  return healthRedisClient;
}

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
