import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { after, before, test } from "node:test";

import { applyIsolatedTestEnv, assertSafeTestRedisUrl } from "../setup/test-env";

/* -------------------------------------- Config -------------------------------------- */

const runDbTests = process.env.RUN_DB_TESTS === "1";

// ต่อ Redis จริง (ไม่ใช่ FakeRedis ที่ route test ใช้) เพื่อพิสูจน์ atomicity ของ ZADD/ZPOPMIN จริง
// ดู test/README.md และ test/concurrency/README.md — เทสกลุ่มนี้ครอบคลุมทั้ง FIFO ordering และ
// การเข้าคิว/pop พร้อมกันจริงของ src/queues/worker-queue.ts
let workerQueue: typeof import("../../src/queues/worker-queue");

// Function สร้าง account id ปลอมที่ไม่ชนกับ run อื่น (Redis DB 15 อาจมี key ค้างจาก run ก่อนหน้า)
function buildTestAccountId(seed: number): number {
  return 900_000_000 + Date.now() % 1_000_000 + randomInt(0, 1000) * 10 + seed;
}

/* -------------------------------------- Setup -------------------------------------- */

before(async () => {
  if (!runDbTests) {
    return;
  }

  applyIsolatedTestEnv("concurrency");
  assertSafeTestRedisUrl();

  workerQueue = await import("../../src/queues/worker-queue");
});

after(async () => {
  if (!runDbTests || !workerQueue) {
    return;
  }

  await workerQueue.closeWorkerQueueConnections();
});

/* -------------------------------------- Tests -------------------------------------- */

test(
  "enqueueWorker preserves FIFO order when popped back out",
  {
    skip: runDbTests
      ? false
      : "Set RUN_DB_TESTS=1 and run Redis (docker compose --profile local-db up -d redis) before this test.",
  },
  async () => {
    const accountIds = [1, 2, 3].map((seed) => buildTestAccountId(seed));

    try {
      // enqueue ตามลำดับ A, B, C — buildWorkerQueueScore() การันตี score เพิ่มขึ้นเสมอแม้เรียกรัวๆ
      // ในมิลลิวินาทีเดียวกัน (ดู src/queues/worker-queue.ts) จึงไม่ต้องใส่ delay ระหว่าง enqueue
      for (const accountId of accountIds) {
        await workerQueue.enqueueWorker(accountId);
      }

      const popped = await workerQueue.popReadyWorkers(3);
      const poppedIds = popped.map((entry) => entry.worker_id);

      assert.deepEqual(
        poppedIds,
        accountIds,
        "Workers must pop out in the same order they were enqueued (FIFO)."
      );
    } finally {
      // ล้าง status hash ที่เหลือใน Redis (queue เองถูกล้างไปแล้วตอน popReadyWorkers)
      await Promise.all(accountIds.map((accountId) => workerQueue.markWorkerOpenApp(accountId)));
    }
  }
);

test(
  "concurrent popReadyWorkers calls never return the same worker twice (ZPOPMIN atomicity)",
  {
    skip: runDbTests
      ? false
      : "Set RUN_DB_TESTS=1 and run Redis (docker compose --profile local-db up -d redis) before this test.",
  },
  async () => {
    const workerCount = 20;
    const accountIds = Array.from({ length: workerCount }, (_, index) =>
      buildTestAccountId(index)
    );

    try {
      for (const accountId of accountIds) {
        await workerQueue.enqueueWorker(accountId);
      }

      // ยิง popReadyWorkers(1) พร้อมกันจริง (ไม่ await ทีละตัว) จำลอง dispatch หลาย process แข่งกันดึง
      // Worker คนเดียวกันออกจากคิว — ถ้า ZPOPMIN ไม่ atomic จริง จะเห็น worker ซ้ำหรือหายไปจากผลรวม
      const results = await Promise.all(
        Array.from({ length: workerCount }, () => workerQueue.popReadyWorkers(1))
      );

      const poppedIds = results.flat().map((entry) => entry.worker_id);

      assert.equal(
        poppedIds.length,
        workerCount,
        "Every concurrent pop must return exactly one worker each, none empty."
      );
      assert.equal(
        new Set(poppedIds).size,
        workerCount,
        "No worker may be popped by more than one concurrent caller."
      );
      assert.deepEqual(
        [...poppedIds].sort((a, b) => a - b),
        [...accountIds].sort((a, b) => a - b),
        "The set of popped workers must exactly match the set that was enqueued."
      );
    } finally {
      await Promise.all(accountIds.map((accountId) => workerQueue.markWorkerOpenApp(accountId)));
    }
  }
);
