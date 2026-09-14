import assert from "node:assert/strict";
import { test } from "node:test";

import { ASSIGNMENT_STATUS } from "../../../src/constants/status";
import { listWorkerPerformance } from "../../../src/repositories/admin-audit.repository";
import { WORKER_ASSIGNMENT_EVENT_TYPE } from "../../../src/types/shared/worker-assignment-event.type";
import { buildBangkokDateRange } from "../../../src/utils/time";
import { assertSafeTestDatabaseUrl } from "../../setup/test-env";

/* -------------------------------------- Config -------------------------------------- */

const runDbTests = process.env.RUN_DB_TESTS === "1";

/* -------------------------------------- Helpers -------------------------------------- */

class RollbackTestTransaction extends Error {}

async function runRollbackTest(
  callback: (
    tx: Parameters<
      Parameters<typeof import("../../../src/db/prisma").withTransaction>[0]
    >[0],
  ) => Promise<void>,
): Promise<void> {
  const { prisma, closePrisma } = await import("../../../src/db/prisma");

  try {
    await prisma.$transaction(async (tx) => {
      await callback(tx);
      throw new RollbackTestTransaction();
    });
  } catch (error) {
    if (!(error instanceof RollbackTestTransaction)) {
      throw error;
    }
  } finally {
    await closePrisma();
  }
}

function bangkokDateToUtc(date: string, hour: number): Date {
  return new Date(
    `${date}T${String(hour).padStart(2, "0")}:00:00.000+07:00`,
  );
}

async function createWorker(
  tx: Parameters<
    Parameters<typeof import("../../../src/db/prisma").withTransaction>[0]
  >[0],
  suffix: string,
  sequence: number,
) {
  return tx.masterWorker.create({
    data: {
      laborCode: `audit-${suffix}-${String(sequence).padStart(3, "0")}`,
      passwordHash: "integration-test-hash",
      status: 1,
      fullName: `Audit Worker ${sequence}`,
      source: "admin_created",
    },
  });
}

async function createTicketJob(
  tx: Parameters<
    Parameters<typeof import("../../../src/db/prisma").withTransaction>[0]
  >[0],
  suffix: string,
  sequence: number,
) {
  return tx.ticketJob.create({
    data: {
      ticketNumber: `AUDIT-${suffix}-${sequence}`,
      licensePlate: `AUD-${sequence}`,
      workersRequired: 1,
      status: "WAIT",
      driverQrToken: `audit-driver-token-${suffix}-${sequence}`,
    },
  });
}

async function createAssignment(
  tx: Parameters<
    Parameters<typeof import("../../../src/db/prisma").withTransaction>[0]
  >[0],
  input: {
    suffix: string;
    sequence: number;
    workerId: number;
    status: string;
    createdAt: Date;
    acceptedAt?: Date | null;
    scannedAt?: Date | null;
    completedAt?: Date | null;
    events?: string[];
  },
) {
  const ticketJob = await createTicketJob(tx, input.suffix, input.sequence);
  const assignment = await tx.ticketJobAssignment.create({
    data: {
      ticketJobId: ticketJob.id,
      workerId: input.workerId,
      status: input.status,
      acceptedAt: input.acceptedAt ?? null,
      scannedAt: input.scannedAt ?? null,
      completedAt: input.completedAt ?? null,
      createdAt: input.createdAt,
      updatedAt: input.completedAt ?? input.createdAt,
    },
  });

  for (const eventType of input.events ?? []) {
    await tx.workerAssignmentEvent.create({
      data: {
        assignmentId: assignment.id,
        workerId: input.workerId,
        ticketJobId: ticketJob.id,
        eventType,
        occurredAt: input.completedAt ?? input.createdAt,
      },
    });
  }

  return assignment;
}

/* -------------------------------------- Tests -------------------------------------- */

test(
  "admin audit repository aggregates real PostgreSQL worker metrics and preserves event semantics",
  {
    skip: runDbTests
      ? false
      : "Set RUN_DB_TESTS=1 and run PostgreSQL migration before this test.",
  },
  async () => {
    assertSafeTestDatabaseUrl();

    await runRollbackTest(async (tx) => {
      const suffix = `metrics-${Date.now().toString(36)}`;
      const inRange = bangkokDateToUtc("2026-08-15", 10);
      const outOfRange = bangkokDateToUtc("2026-08-16", 1);
      const workerA = await createWorker(tx, suffix, 1);
      const workerB = await createWorker(tx, suffix, 2);
      const workerNull = await createWorker(tx, suffix, 3);

      await createAssignment(tx, {
        suffix,
        sequence: 1,
        workerId: workerA.id,
        status: ASSIGNMENT_STATUS.COMPLETED,
        createdAt: inRange,
        acceptedAt: inRange,
        scannedAt: inRange,
        completedAt: inRange,
        events: [
          WORKER_ASSIGNMENT_EVENT_TYPE.ACCEPTED,
          WORKER_ASSIGNMENT_EVENT_TYPE.COMPLETED,
        ],
      });
      await createAssignment(tx, {
        suffix,
        sequence: 2,
        workerId: workerA.id,
        status: ASSIGNMENT_STATUS.TIMEOUT,
        createdAt: inRange,
      });
      await createAssignment(tx, {
        suffix,
        sequence: 3,
        workerId: workerA.id,
        status: ASSIGNMENT_STATUS.TIMEOUT,
        createdAt: inRange,
        acceptedAt: inRange,
        events: [WORKER_ASSIGNMENT_EVENT_TYPE.SCAN_TIMEOUT],
      });
      await createAssignment(tx, {
        suffix,
        sequence: 4,
        workerId: workerA.id,
        status: ASSIGNMENT_STATUS.PENDING,
        createdAt: inRange,
        events: [WORKER_ASSIGNMENT_EVENT_TYPE.ACCEPT_TIMEOUT],
      });
      await createAssignment(tx, {
        suffix,
        sequence: 5,
        workerId: workerA.id,
        status: ASSIGNMENT_STATUS.ACCEPTED,
        createdAt: inRange,
        acceptedAt: inRange,
        events: [WORKER_ASSIGNMENT_EVENT_TYPE.ADMIN_CANCELLED],
      });
      await createAssignment(tx, {
        suffix,
        sequence: 6,
        workerId: workerB.id,
        status: ASSIGNMENT_STATUS.COMPLETED,
        createdAt: inRange,
        acceptedAt: inRange,
        scannedAt: inRange,
        completedAt: inRange,
      });
      await createAssignment(tx, {
        suffix,
        sequence: 7,
        workerId: workerNull.id,
        status: ASSIGNMENT_STATUS.CANCELLED,
        createdAt: inRange,
      });
      await createAssignment(tx, {
        suffix,
        sequence: 8,
        workerId: workerB.id,
        status: ASSIGNMENT_STATUS.TIMEOUT,
        createdAt: outOfRange,
      });

      const { startAt, endAt } = buildBangkokDateRange("2026-08-15");
      const result = await listWorkerPerformance(
        {
          startAt,
          endAt,
          page: 1,
          limit: 20,
          sort_by: "accept_rate",
          sort_order: "desc",
        },
        tx,
      );

      assert.equal(result.total, 3);
      assert.equal(result.data[0].worker_code, workerB.laborCode);
      assert.equal(result.data[0].accept_rate, "100.00");

      const workerAMetrics = result.data.find(
        (record) => record.worker_code === workerA.laborCode,
      );

      assert.ok(workerAMetrics);
      assert.equal(workerAMetrics.total_assigned_job_count, 5);
      assert.equal(workerAMetrics.accepted_job_count, 3);
      assert.equal(workerAMetrics.accept_timeout_job_count, 2);
      assert.equal(workerAMetrics.scan_timeout_job_count, 1);
      assert.equal(workerAMetrics.completed_job_count, 1);
      assert.equal(workerAMetrics.admin_cancelled_job_count, 1);
      assert.equal(workerAMetrics.accept_rate, "60.00");

      const nullMetrics = result.data.find(
        (record) => record.worker_code === workerNull.laborCode,
      );

      assert.ok(nullMetrics);
      assert.equal(nullMetrics.accept_rate, null);
      assert.equal(nullMetrics.admin_cancelled_job_count, 0);

      const filtered = await listWorkerPerformance(
        {
          startAt,
          endAt,
          worker_code: workerA.laborCode,
          page: 1,
          limit: 20,
          sort_by: "accept_rate",
          sort_order: "desc",
        },
        tx,
      );

      assert.equal(filtered.total, 1);
      assert.equal(filtered.data[0].worker_code, workerA.laborCode);
    });
  },
);

test(
  "admin audit repository paginates in PostgreSQL and keeps total on an empty page",
  {
    skip: runDbTests
      ? false
      : "Set RUN_DB_TESTS=1 and run PostgreSQL migration before this test.",
  },
  async () => {
    assertSafeTestDatabaseUrl();

    await runRollbackTest(async (tx) => {
      const suffix = `paging-${Date.now().toString(36)}`;
      const createdAt = bangkokDateToUtc("2026-08-20", 9);

      for (let index = 0; index < 25; index += 1) {
        const worker = await createWorker(tx, suffix, index + 1);

        await createAssignment(tx, {
          suffix,
          sequence: index + 1,
          workerId: worker.id,
          status: ASSIGNMENT_STATUS.COMPLETED,
          createdAt,
          acceptedAt: createdAt,
          scannedAt: createdAt,
          completedAt: createdAt,
        });
      }

      const { startAt, endAt } = buildBangkokDateRange("2026-08-20");
      const pageTwo = await listWorkerPerformance(
        {
          startAt,
          endAt,
          page: 2,
          limit: 20,
          sort_by: "accept_rate",
          sort_order: "desc",
        },
        tx,
      );

      assert.equal(pageTwo.total, 25);
      assert.equal(pageTwo.data.length, 5);

      const pageThree = await listWorkerPerformance(
        {
          startAt,
          endAt,
          page: 3,
          limit: 20,
          sort_by: "accept_rate",
          sort_order: "desc",
        },
        tx,
      );

      assert.equal(pageThree.total, 25);
      assert.deepEqual(pageThree.data, []);
    });
  },
);
