// Import Config
import { getPrisma } from "../db/prisma";
// Import Queues
import { bullProducerConnection } from "../queues/bull-connection";
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

// Function ตรวจว่า Redis พร้อมใช้งาน (ping ผ่าน connection ที่ระบบใช้จริง ล้มเร็วเมื่อ Redis ล่ม)
async function checkRedisReady(): Promise<ReadinessCheck> {
  try {
    await bullProducerConnection.ping();
    return { status: "ok" };
  } catch (error) {
    logger.error("Readiness Redis check failed.", { error });
    return {
      status: "error",
    };
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
