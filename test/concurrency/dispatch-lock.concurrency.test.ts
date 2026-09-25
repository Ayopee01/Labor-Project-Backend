import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import {
  applyIsolatedTestEnv,
  assertSafeTestDatabaseUrl,
  assertSafeTestRedisUrl,
} from "../setup/test-env";

/* -------------------------------------- Config -------------------------------------- */

const runDbTests = process.env.RUN_DB_TESTS === "1";

// ต่อ Postgres + Redis จริงทั้งคู่ (ไม่ mock) เพื่อพิสูจน์ว่า SELECT ... FOR UPDATE ใน
// dispatchReadyWorkersForTicketJob (src/queues/worker-dispatch.ts) กันสอง process จ่าย Worker
// ให้ TicketJob คันเดียวกันเกิน workers_required จริงไหม ดู test/concurrency/README.md
let prismaModule: typeof import("../../src/db/prisma");
let workerQueue: typeof import("../../src/queues/worker-queue");
let workerDispatch: typeof import("../../src/queues/worker-dispatch");

/* -------------------------------------- Helpers -------------------------------------- */

// Function ดึงเวลาปัจจุบันตามเขตเวลา Asia/Bangkok เป็นนาที (0-1439) ใช้คำนวณ time_in/time_out
// ให้ isTimeInWorkSchedule() มองว่า Worker ปลอมที่สร้างขึ้นในเทสนี้ "อยู่ในกะ" เสมอไม่ว่าจะรันตอนไหน
function getCurrentBangkokMinutes(): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(new Date());
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);

  return hour * 60 + minute;
}

// Function แปลงนาที (wrap รอบวันได้) กลับเป็นรูปแบบ HH:mm
function formatMinutesAsTime(totalMinutes: number): string {
  const wrapped = ((totalMinutes % 1440) + 1440) % 1440;
  const hour = Math.floor(wrapped / 60);
  const minute = wrapped % 60;

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

// Function สร้างช่วงกะ 6 ชั่วโมงคร่อมเวลาปัจจุบันเสมอ (+/- 3 ชั่วโมง) กันเทสพังตอนรันใกล้รอยต่อกะจริง
function buildAlwaysActiveSchedule(): { time_in: string; time_out: string } {
  const nowMinutes = getCurrentBangkokMinutes();

  return {
    time_in: formatMinutesAsTime(nowMinutes - 180),
    time_out: formatMinutesAsTime(nowMinutes + 180),
  };
}

/* -------------------------------------- Setup -------------------------------------- */

before(async () => {
  if (!runDbTests) {
    return;
  }

  applyIsolatedTestEnv("concurrency");
  assertSafeTestDatabaseUrl();
  assertSafeTestRedisUrl();

  prismaModule = await import("../../src/db/prisma");
  workerQueue = await import("../../src/queues/worker-queue");
  workerDispatch = await import("../../src/queues/worker-dispatch");
});

after(async () => {
  if (!runDbTests) {
    return;
  }

  if (workerQueue) {
    await workerQueue.closeWorkerQueueConnections();
  }

  if (prismaModule) {
    await prismaModule.closePrisma();
  }
});

/* -------------------------------------- Tests -------------------------------------- */

test(
  "concurrent dispatchReadyWorkers calls never assign more workers than workers_required (row lock)",
  {
    skip: runDbTests
      ? false
      : "Set RUN_DB_TESTS=1 and run PostgreSQL + Redis before this test.",
  },
  async () => {
    const suffix = Date.now().toString(36);
    const workersRequired = 3;
    // ตั้งใจ enqueue Worker ที่พร้อมมากกว่า workers_required เพื่อให้เห็นผลชัดถ้า lock ไม่ทำงานจริง
    // (ถ้าพัง จะเห็นจำนวน assignment เกิน workersRequired ทันที ไม่ใช่แค่เท่ากันโดยบังเอิญ)
    const readyWorkerCount = 5;
    const schedule = buildAlwaysActiveSchedule();

    const workerIds: number[] = [];
    let ticketJobId: number | null = null;

    try {
      for (let index = 0; index < readyWorkerCount; index += 1) {
        const worker = await prismaModule.prisma.masterWorker.create({
          data: {
            laborCode: `CC-DISPATCH-${suffix}-${index}`,
            status: 1,
            shiftName: "Morning",
            timeIn: schedule.time_in,
            timeOut: schedule.time_out,
          },
        });

        workerIds.push(worker.id);
      }

      const ticketJob = await prismaModule.prisma.ticketJob.create({
        data: {
          ticketNumber: `CC-DISPATCH-${suffix}`,
          licensePlate: "1กก-9999",
          workersRequired,
          driverQrToken: `CC-DISPATCH-QR-${suffix}`,
          status: "WORKING",
        },
      });

      ticketJobId = ticketJob.id;

      for (const workerId of workerIds) {
        await workerQueue.enqueueWorker(workerId);
      }

      // ยิง dispatch พร้อมกันจริง 2 ครั้งไปที่งานรถคันเดียวกัน — ถ้า SELECT ... FOR UPDATE ไม่ล็อกจริง
      // ทั้งสอง transaction จะเห็น activeAssignments=0 พร้อมกันและ assign เกิน workersRequired
      await Promise.all([
        workerDispatch.dispatchReadyWorkers(undefined, {
          vehicle_job_ids: [ticketJob.id],
        }),
        workerDispatch.dispatchReadyWorkers(undefined, {
          vehicle_job_ids: [ticketJob.id],
        }),
      ]);

      const assignments = await prismaModule.prisma.ticketJobAssignment.findMany({
        where: { ticketJobId: ticketJob.id },
      });

      assert.equal(
        assignments.length,
        workersRequired,
        `Expected exactly ${workersRequired} assignments (workers_required), got ${assignments.length} — the row lock failed to prevent over-dispatch.`
      );
      assert.equal(
        new Set(assignments.map((assignment) => assignment.workerId)).size,
        assignments.length,
        "No worker may be assigned to the same vehicle job twice."
      );
    } finally {
      if (ticketJobId !== null) {
        await prismaModule.prisma.ticketJobAssignment.deleteMany({
          where: { ticketJobId },
        });
        await prismaModule.prisma.ticketJob.delete({ where: { id: ticketJobId } });
      }

      await Promise.all(workerIds.map((workerId) => workerQueue.markWorkerOpenApp(workerId)));

      if (workerIds.length > 0) {
        await prismaModule.prisma.masterWorker.deleteMany({
          where: { id: { in: workerIds } },
        });
      }
    }
  }
);
