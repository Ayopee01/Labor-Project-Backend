// Import Library
import assert from "node:assert/strict";
import { test } from "node:test";
// Import Repositories
import * as adminJobsRepository from "../../../src/repositories/admin-jobs.repository";
// Import Types
import type { DbConnection } from "../../../src/types/shared/common.type";
// Import Utils
import { formatVehicleOperationItem } from "../../../src/utils/admin-job-operations.formatter";
// Import Helpers
import { assertSafeTestDatabaseUrl } from "../../setup/test-env";

/* -------------------------------------- Config -------------------------------------- */

const runDbTests = process.env.RUN_DB_TESTS === "1";

/* -------------------------------------- Helpers -------------------------------------- */

// Class error ใช้บังคับ rollback transaction หลังจบ test
class RollbackTestTransaction extends Error {}

// Function รัน callback ใน transaction แล้ว rollback เสมอ
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

// Function สร้างงานรถพร้อมตลาดหนึ่งตลาด
async function createTicketJobAndMarketJob(
  tx: DbConnection,
  suffix: string,
): Promise<{ ticketJobId: number; marketJobId: number; ticketNumber: string }> {
  const ticketNumber = `OPS-IT-${suffix}`;
  const ticketJob = await tx.ticketJob.create({
    data: {
      ticketNumber,
      licensePlate: "1กก-1234",
      workersRequired: 1,
      driverQrToken: `OPS-IT-QR-${suffix}`,
      status: "WORKING",
    },
  });
  const marketJob = await tx.marketJob.create({
    data: {
      ticketJobId: ticketJob.id,
      ticketNo: `OPS-IT-TN-${suffix}`,
      ticketCreatedAt: new Date(),
      workersRequired: 1,
      gateTransactionRef: `OPS-IT-REF-${suffix}`,
      marketCode: "MKT1",
      marketName: "Market One",
      status: "WORKING",
    },
  });

  return { ticketJobId: ticketJob.id, marketJobId: marketJob.id, ticketNumber };
}

// Function สร้างแผงในตลาด
async function createBoothJob(
  tx: DbConnection,
  ticketJobId: number,
  marketJobId: number,
  boothCode: string,
): Promise<number> {
  const booth = await tx.boothJob.create({
    data: {
      ticketJobId,
      marketJobId,
      boothCode,
      status: "DELIVERED",
    },
  });

  return booth.id;
}

// Function สร้างผู้ส่งยอด (Worker และ Admin ที่ส่งแทน)
async function createSubmitters(
  tx: DbConnection,
  suffix: string,
): Promise<{ workerId: number; adminId: number }> {
  const worker = await tx.masterWorker.create({
    data: {
      laborCode: `OPSW-${suffix}`,
      status: 1,
    },
  });
  const admin = await tx.account.create({
    data: {
      username: `ops-admin-${suffix}`,
      passwordHash: "x",
      role: "admin",
      fullName: `Admin ${suffix}`,
    },
  });

  return { workerId: worker.id, adminId: admin.id };
}

// Type ผู้ส่งยอดของรอบส่ง
type Submitter = { role: "worker"; workerId: number } | { role: "admin"; adminId: number };

// Function สร้างรอบส่งยอดของแผงตามเวลาที่กำหนด
async function createSubmission(
  tx: DbConnection,
  ticketId: number,
  createdAt: string,
  options: { status: string; submitter: Submitter; confirmedAt?: string },
): Promise<void> {
  const { submitter } = options;

  await tx.ticketCompletionSubmission.create({
    data: {
      ticketId,
      submittedByRole: submitter.role,
      submittedByWorkerId: submitter.role === "worker" ? submitter.workerId : null,
      submittedByAccountId: submitter.role === "admin" ? submitter.adminId : null,
      status: options.status,
      confirmedAt: options.confirmedAt ? new Date(options.confirmedAt) : null,
      workerCountSnapshot: 1,
      createdAt: new Date(createdAt),
    },
  });
}

/* -------------------------------------- Tests -------------------------------------- */

test(
  "adminJobsRepository.listTicketJobOperations returns SubmittedAt per booth from the latest submission round against real PostgreSQL",
  {
    skip: runDbTests
      ? false
      : "Set RUN_DB_TESTS=1 and run PostgreSQL migration before this test.",
  },
  async () => {
    assertSafeTestDatabaseUrl();

    const suffix = Date.now().toString(36);

    await runRollbackTest(async (tx) => {
      const { ticketJobId, marketJobId, ticketNumber } = await createTicketJobAndMarketJob(tx, suffix);
      const confirmedBooth = await createBoothJob(tx, ticketJobId, marketJobId, `B1-${suffix}`);
      const resubmittedBooth = await createBoothJob(tx, ticketJobId, marketJobId, `B2-${suffix}`);
      const unsubmittedBooth = await createBoothJob(tx, ticketJobId, marketJobId, `B3-${suffix}`);
      const { workerId, adminId } = await createSubmitters(tx, suffix);

      // Scenario 1: ส่งยอด 10:00 ร้านค้ายืนยัน 11:05 ต้องได้เวลาส่งยอด ไม่ใช่เวลายืนยัน
      await createSubmission(tx, confirmedBooth, "2026-07-01T03:00:00.000Z", {
        status: "CONFIRMED",
        submitter: { role: "worker", workerId },
        confirmedAt: "2026-07-01T04:05:00.000Z",
      });
      await tx.boothJob.update({
        where: { id: confirmedBooth },
        data: { status: "COMPLETED", updatedAt: new Date("2026-07-01T04:05:00.000Z") },
      });

      // Scenario 2: Worker ส่งแล้วถูกปฏิเสธ Admin ส่งใหม่แทน ต้องได้เวลารอบใหม่ (สร้างรอบใหม่ก่อนเพื่อให้ id ไม่ตรงกับลำดับเวลา)
      await createSubmission(tx, resubmittedBooth, "2026-07-01T04:15:00.000Z", {
        status: "DELIVERED",
        submitter: { role: "admin", adminId },
      });
      await createSubmission(tx, resubmittedBooth, "2026-07-01T03:20:00.000Z", {
        status: "REJECT",
        submitter: { role: "worker", workerId },
      });

      const { records } = await adminJobsRepository.listTicketJobOperations(
        { search: ticketNumber },
        tx,
      );
      const record = records.find((candidate) => candidate.id === ticketJobId);

      assert.ok(record, "operation record must be returned");

      // Repository ต้องดึงเฉพาะรอบล่าสุดของแต่ละแผง
      const submissionsByBooth = new Map(
        record.marketJobs
          .flatMap((market) => market.tickets)
          .map((ticket) => [ticket.id, ticket.completionSubmissions]),
      );

      assert.equal(submissionsByBooth.get(resubmittedBooth)?.length, 1);
      assert.equal(submissionsByBooth.get(unsubmittedBooth)?.length, 0);

      const booths = new Map(
        formatVehicleOperationItem(record)
          .markets.flatMap((market) => market.booths)
          .map((booth) => [Number(booth.booth_job_id), booth]),
      );

      assert.equal(booths.get(confirmedBooth)?.submitted_at, "2026-07-01T03:00:00.000Z");
      assert.equal(booths.get(confirmedBooth)?.updated_at, "2026-07-01T04:05:00.000Z");
      assert.equal(booths.get(resubmittedBooth)?.submitted_at, "2026-07-01T04:15:00.000Z");
      assert.equal(booths.get(unsubmittedBooth)?.submitted_at, null);
    });
  },
);
