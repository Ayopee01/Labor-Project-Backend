import assert from "node:assert/strict";
import { test } from "node:test";

import { ASSIGNMENT_STATUS, TICKET_WORKER_STATUS } from "../../../src/constants/status";
import * as ticketJobLifecycleService from "../../../src/services/shared/ticket-job-lifecycle.service";
import type { DbConnection } from "../../../src/types/shared/common.type";
import { assertSafeTestDatabaseUrl } from "../../setup/test-env";

/* -------------------------------------- Config -------------------------------------- */

const runDbTests = process.env.RUN_DB_TESTS === "1";

/* -------------------------------------- Helpers -------------------------------------- */

// Regression net for ticketJobLifecycleService.syncTicketWorkerRoster — owns the roster diff/lock
// decisions moved out of ticket-worker.repository.ts (Group 1A cleanup). Route-level tests mock the
// repository layer entirely, so they cannot catch a regression in the real Prisma diff/lock
// sequence — only this test can.
class RollbackTestTransaction extends Error {}

async function runRollbackTest(
  callback: (tx: DbConnection) => Promise<void>
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

async function createWorker(tx: DbConnection, laborCode: string): Promise<number> {
  const worker = await tx.masterWorker.create({
    data: {
      laborCode,
      status: 1,
    },
  });

  return worker.id;
}

async function createTicketJobAndMarketJob(
  tx: DbConnection,
  suffix: string,
): Promise<{ ticketJobId: number; marketJobId: number }> {
  const ticketJob = await tx.ticketJob.create({
    data: {
      ticketNumber: `TW-IT-${suffix}`,
      licensePlate: "1กก-1234",
      workersRequired: 4,
      driverQrToken: `TW-IT-QR-${suffix}`,
      status: "WORKING",
    },
  });
  const marketJob = await tx.marketJob.create({
    data: {
      ticketJobId: ticketJob.id,
      ticketNo: `TW-IT-TN-${suffix}`,
      ticketCreatedAt: new Date(),
      workersRequired: 4,
      gateTransactionRef: `TW-IT-REF-${suffix}`,
      marketCode: "MKT1",
      marketName: "Market One",
      status: "WORKING",
    },
  });

  return { ticketJobId: ticketJob.id, marketJobId: marketJob.id };
}

async function createAssignment(
  tx: DbConnection,
  ticketJobId: number,
  workerId: number,
  status: string,
): Promise<number> {
  const assignment = await tx.ticketJobAssignment.create({
    data: {
      ticketJobId,
      workerId,
      status,
      acceptDeadlineAt: new Date(),
      acceptedAt: status === ASSIGNMENT_STATUS.PENDING ? null : new Date(),
      scannedAt:
        status === ASSIGNMENT_STATUS.PENDING || status === ASSIGNMENT_STATUS.ACCEPTED
          ? null
          : new Date(),
    },
  });

  return assignment.id;
}

/* -------------------------------------- Tests -------------------------------------- */

test(
  "ticketJobLifecycleService.syncTicketWorkerRoster preserves roster diff/lock business rules against real PostgreSQL",
  {
    skip: runDbTests
      ? false
      : "Set RUN_DB_TESTS=1 and run PostgreSQL migration before this test.",
  },
  async () => {
    assertSafeTestDatabaseUrl();

    const suffix = Date.now().toString(36);

    await runRollbackTest(async (tx) => {
      const worker1 = await createWorker(tx, `TWW1-${suffix}`);
      const worker2 = await createWorker(tx, `TWW2-${suffix}`);
      const worker3 = await createWorker(tx, `TWW3-${suffix}`);
      const worker4 = await createWorker(tx, `TWW4-${suffix}`);
      const { ticketJobId, marketJobId } = await createTicketJobAndMarketJob(tx, suffix);

      // --- Scenario 1: fresh sync creates roster rows for every active (SCANNED_ASSIGNMENT_
      // STATUSES) assignment, nothing more ---
      await createAssignment(tx, ticketJobId, worker1, ASSIGNMENT_STATUS.SCANNED);
      await createAssignment(tx, ticketJobId, worker2, ASSIGNMENT_STATUS.WORKING);

      const afterFirstSync = await ticketJobLifecycleService.syncTicketWorkerRoster(
        marketJobId,
        ticketJobId,
        tx,
      );

      assert.equal(afterFirstSync.length, 2, "should create exactly 2 roster rows");
      const byWorkerIdAfterFirst = new Map(
        afterFirstSync.map((worker) => [worker.worker_id, worker]),
      );
      assert.equal(byWorkerIdAfterFirst.get(worker1)?.status, TICKET_WORKER_STATUS.WORKING);
      assert.equal(byWorkerIdAfterFirst.get(worker2)?.status, TICKET_WORKER_STATUS.WORKING);

      // --- Scenario 2: re-sync after a 3rd worker scans in must ADD the new member without
      // touching the existing 2 ---
      await createAssignment(tx, ticketJobId, worker3, ASSIGNMENT_STATUS.SCANNED);

      const afterSecondSync = await ticketJobLifecycleService.syncTicketWorkerRoster(
        marketJobId,
        ticketJobId,
        tx,
      );

      assert.equal(afterSecondSync.length, 3, "should add the 3rd worker, keep the first 2");
      const byWorkerIdAfterSecond = new Map(
        afterSecondSync.map((worker) => [worker.worker_id, worker]),
      );
      assert.equal(byWorkerIdAfterSecond.get(worker1)?.id, byWorkerIdAfterFirst.get(worker1)?.id, "worker1 row must be reused, not recreated");
      assert.equal(byWorkerIdAfterSecond.get(worker2)?.id, byWorkerIdAfterFirst.get(worker2)?.id, "worker2 row must be reused, not recreated");
      assert.equal(byWorkerIdAfterSecond.get(worker3)?.status, TICKET_WORKER_STATUS.WORKING);

      // --- Scenario 3: worker2's assignment moves to RELEASED (still inside
      // SCANNED_ASSIGNMENT_STATUSES on purpose) -> sync must NOT cancel worker2's roster row.
      // This is the exact invariant documented on SCANNED_ASSIGNMENT_STATUSES in status.ts ---
      await tx.ticketJobAssignment.updateMany({
        where: { ticketJobId, workerId: worker2 },
        data: { status: ASSIGNMENT_STATUS.RELEASED, releasedAt: new Date() },
      });

      const afterReleaseSync = await ticketJobLifecycleService.syncTicketWorkerRoster(
        marketJobId,
        ticketJobId,
        tx,
      );
      const byWorkerIdAfterRelease = new Map(
        afterReleaseSync.map((worker) => [worker.worker_id, worker]),
      );

      assert.equal(
        byWorkerIdAfterRelease.get(worker2)?.status,
        TICKET_WORKER_STATUS.WORKING,
        "RELEASED assignment must NOT cancel the TicketWorker roster row",
      );

      // --- Scenario 4: worker1's assignment drops OUT of SCANNED_ASSIGNMENT_STATUSES entirely
      // (TIMEOUT, e.g. lost the scan-timeout race) -> sync MUST cancel worker1's roster row ---
      await tx.ticketJobAssignment.updateMany({
        where: { ticketJobId, workerId: worker1 },
        data: { status: ASSIGNMENT_STATUS.TIMEOUT },
      });

      const afterTimeoutSync = await ticketJobLifecycleService.syncTicketWorkerRoster(
        marketJobId,
        ticketJobId,
        tx,
      );
      const byWorkerIdAfterTimeout = new Map(
        afterTimeoutSync.map((worker) => [worker.worker_id, worker]),
      );

      assert.equal(
        byWorkerIdAfterTimeout.get(worker1)?.status,
        TICKET_WORKER_STATUS.CANCELLED,
        "worker dropped out of SCANNED_ASSIGNMENT_STATUSES must be cancelled from the roster",
      );
      assert.ok(byWorkerIdAfterTimeout.get(worker1)?.cancelled_at, "cancelled_at must be set");
      assert.equal(byWorkerIdAfterTimeout.get(worker3)?.status, TICKET_WORKER_STATUS.WORKING);

      // --- Scenario 5: MarketJob roster gets locked (workerRosterLockedAt set) -> sync becomes
      // a pure read, even when a brand-new active assignment (worker4) appears afterward ---
      await tx.marketJob.update({
        where: { id: marketJobId },
        data: { workerRosterLockedAt: new Date() },
      });
      await createAssignment(tx, ticketJobId, worker4, ASSIGNMENT_STATUS.SCANNED);

      const afterLockSync = await ticketJobLifecycleService.syncTicketWorkerRoster(
        marketJobId,
        ticketJobId,
        tx,
      );

      assert.equal(afterLockSync.length, 3, "locked roster must not gain worker4");
      assert.ok(
        !afterLockSync.some((worker) => worker.worker_id === worker4),
        "worker4 must not appear once the roster is locked",
      );
      const byWorkerIdAfterLock = new Map(
        afterLockSync.map((worker) => [worker.worker_id, worker]),
      );
      assert.equal(
        byWorkerIdAfterLock.get(worker1)?.status,
        TICKET_WORKER_STATUS.CANCELLED,
        "locked roster read must still reflect worker1 as cancelled from before the lock",
      );
    });
  }
);
