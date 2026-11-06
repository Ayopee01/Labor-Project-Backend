// Import Library
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
// Import Helpers
import { applyIsolatedTestEnv, assertSafeTestDatabaseUrl, assertSafeTestRedisUrl } from "../setup/test-env";

/* -------------------------------------- Config -------------------------------------- */

const runDbTests = process.env.RUN_DB_TESTS === "1";
const skipReason = runDbTests ? false : "Set RUN_DB_TESTS=1 and run PostgreSQL + Redis before this test.";

// ใช้ Postgres + Redis จริง พิสูจน์ว่าการเรียก worker คนเดิมกลับรถได้รอบเดียวแม้ชนกันหลายทาง
let prismaModule: typeof import("../../src/db/prisma");
let workerQueue: typeof import("../../src/queues/worker-queue");
let workerDispatch: typeof import("../../src/queues/worker-dispatch");
let adminJobsService: typeof import("../../src/services/admin-jobs.service");

/* -------------------------------------- Helpers -------------------------------------- */

// Function สร้างช่วงกะ 6 ชั่วโมงคร่อมเวลาปัจจุบันของ Bangkok เสมอ กันเทสต์พังตอนรันใกล้รอยต่อกะ
function buildAlwaysActiveSchedule(): { time_in: string; time_out: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const nowMinutes =
    Number(parts.find((part) => part.type === "hour")?.value ?? 0) * 60 +
    Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  const format = (minutes: number) => {
    const wrapped = ((minutes % 1440) + 1440) % 1440;

    return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
  };

  return { time_in: format(nowMinutes - 180), time_out: format(nowMinutes + 180) };
}

// Function สร้าง worker, งานรถ และ admin สำหรับเทสต์ พร้อม function ลบข้อมูลทิ้ง
async function seedFixture(suffix: string, vehicleCount: number) {
  const { prisma } = prismaModule;
  const schedule = buildAlwaysActiveSchedule();
  const worker = await prisma.masterWorker.create({
    data: {
      laborCode: `CC-REDISPATCH-${suffix}`,
      status: 1,
      shiftName: "Morning",
      timeIn: schedule.time_in,
      timeOut: schedule.time_out,
    },
  });
  const admin = await prisma.account.create({
    data: {
      username: `cc-redispatch-admin-${suffix}`,
      passwordHash: "x",
      role: "admin",
      fullName: `Admin ${suffix}`,
    },
  });
  const ticketJobs: Array<{ id: number; ticketNumber: string }> = [];

  for (let index = 0; index < vehicleCount; index += 1) {
    ticketJobs.push(
      await prisma.ticketJob.create({
        data: {
          ticketNumber: `CC-REDISPATCH-${suffix}-${index}`,
          licensePlate: "1กก-9999",
          workersRequired: 1,
          driverQrToken: `CC-REDISPATCH-QR-${suffix}-${index}`,
          status: "WORKING",
        },
      }),
    );
  }

  const cleanup = async () => {
    const ticketJobIds = ticketJobs.map((ticketJob) => ticketJob.id);

    await workerQueue.markWorkerOpenApp(worker.id);
    await prisma.adminActionLog.deleteMany({ where: { ticketJobId: { in: ticketJobIds } } });
    await prisma.ticketJobAssignment.deleteMany({ where: { ticketJobId: { in: ticketJobIds } } });
    await prisma.ticketJob.deleteMany({ where: { id: { in: ticketJobIds } } });
    await prisma.workerCheckinLog.deleteMany({ where: { workerId: worker.id } });
    await prisma.workerNotification.deleteMany({ where: { workerId: worker.id } });
    await prisma.masterWorker.delete({ where: { id: worker.id } });
    await prisma.account.delete({ where: { id: admin.id } });
  };

  return { worker, admin, ticketJobs, cleanup };
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
  adminJobsService = await import("../../src/services/admin-jobs.service");
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

for (const previousStatus of ["TIMEOUT", "REJECTED", "CANCELLED"] as const) {
  test(`auto dispatch and admin assign racing for a returning worker (previous round ${previousStatus}) create exactly one active round`, { skip: skipReason }, async () => {
    const fixture = await seedFixture(`${previousStatus.toLowerCase()}-${Date.now().toString(36)}`, 2);
    const [adminTarget] = fixture.ticketJobs;

    try {
      await prismaModule.prisma.ticketJobAssignment.create({
        data: { ticketJobId: adminTarget.id, workerId: fixture.worker.id, status: previousStatus },
      });
      await workerQueue.enqueueWorker(fixture.worker.id);

      const [, adminResult] = await Promise.allSettled([
        workerDispatch.dispatchReadyWorkers(),
        adminJobsService.assignTicketJobWorkers(
          adminTarget.ticketNumber,
          { worker_codes: [fixture.worker.laborCode], reason_code: "MANUAL_ASSIGNMENT", reason_text: "re-dispatch" },
          { account_id: fixture.admin.id, role: "admin", session_id: 0, token_type: "access" },
        ),
      ]);

      if (adminResult.status === "rejected") {
        assert.ok(
          ["WORKER_NOT_READY", "WORKER_HAS_ACTIVE_ASSIGNMENT", "WORKERS_REQUIRED_EXCEEDED"].includes((adminResult.reason as { code?: string }).code ?? ""),
          `Unexpected admin assign error: ${String(adminResult.reason)}`,
        );
      }

      const activeRounds = await prismaModule.prisma.ticketJobAssignment.findMany({
        where: { workerId: fixture.worker.id, status: "PENDING" },
      });

      assert.equal(activeRounds.length, 1, "The returning worker must end up with exactly one active round.");
      assert.equal(
        await prismaModule.prisma.ticketJobAssignment.count({
          where: { workerId: fixture.worker.id, status: previousStatus },
        }),
        1,
        "The previous round must stay in history.",
      );
      assert.equal((await workerQueue.getWorkerQueueStatus(fixture.worker.id))?.status, "assigned");
    } finally {
      await fixture.cleanup();
    }
  });
}

test("an accept timeout racing other dispatch triggers still re-dispatches the only worker to the vehicle exactly once", { skip: skipReason }, async () => {
  const fixture = await seedFixture(`timeout-${Date.now().toString(36)}`, 1);
  const [ticketJob] = fixture.ticketJobs;

  try {
    const assignment = await prismaModule.prisma.ticketJobAssignment.create({
      data: {
        ticketJobId: ticketJob.id,
        workerId: fixture.worker.id,
        status: "PENDING",
        acceptDeadlineAt: new Date(Date.now() - 1_000),
      },
    });

    await workerQueue.markWorkerAssigned(fixture.worker.id);
    await Promise.all([
      workerDispatch.processAssignmentTimeoutJob({ assignmentId: assignment.id, workerId: fixture.worker.id, kind: "accept" }),
      workerDispatch.processAssignmentTimeoutJob({ assignmentId: assignment.id, workerId: fixture.worker.id, kind: "accept" }),
      workerDispatch.dispatchReadyWorkers(),
      workerDispatch.dispatchReadyWorkers(),
    ]);

    // trigger ที่วิ่งก่อนคืนคิวอาจไม่เห็น worker จึงเรียก dispatch ซ้ำแบบ sweep (ต้องไม่สร้างรอบเกิน)
    await workerDispatch.dispatchReadyWorkers();

    const rounds = await prismaModule.prisma.ticketJobAssignment.findMany({
      where: { ticketJobId: ticketJob.id, workerId: fixture.worker.id },
      orderBy: { id: "asc" },
    });
    const attendance = await prismaModule.prisma.workerCheckinLog.findFirst({
      where: { workerId: fixture.worker.id },
    });

    assert.deepEqual(rounds.map((round) => round.status), ["TIMEOUT", "PENDING"]);
    assert.equal(attendance?.acceptTimeoutStreak, 1, "A duplicate timeout job must not count the timeout twice.");
    assert.equal((await workerQueue.getWorkerQueueStatus(fixture.worker.id))?.status, "assigned");
  } finally {
    await fixture.cleanup();
  }
});
