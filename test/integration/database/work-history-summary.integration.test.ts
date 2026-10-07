// Import Library
import assert from "node:assert/strict";
import { test } from "node:test";
// Import Config
import { VEHICLE_JOB_STATUS } from "../../../src/constants/status";
// Import Repositories
import * as adminJobsRepository from "../../../src/repositories/admin-jobs.repository";
// Import Types
import type { DbConnection } from "../../../src/types/shared/common.type";
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

// Function สร้างงานรถ 1 คันพร้อม MarketJob 1 ใบ
async function createTicketJobWithMarket(tx: DbConnection, ticketNumber: string, status: string) {
  const ticketJob = await tx.ticketJob.create({
    data: {
      ticketNumber,
      licensePlate: `PLATE-${ticketNumber}`,
      workersRequired: 1,
      status,
      driverQrToken: `QR-${ticketNumber}`,
    },
  });
  const marketJob = await tx.marketJob.create({
    data: {
      ticketJobId: ticketJob.id,
      ticketNo: `TKT-${ticketNumber}`,
      ticketCreatedAt: new Date(),
      gateTransactionRef: `GATE-${ticketNumber}`,
      workersRequired: 1,
      marketCode: "MKT1",
      marketName: "Market 1",
    },
  });

  return { ticketJob, marketJob };
}

// Function สร้างแผงพร้อมสินค้า 1 รายการ และยอดเงินที่ปิดแล้ว (ถ้าส่ง financial มา)
async function createBoothWithProduct(
  tx: DbConnection,
  input: {
    ticketJobId: number;
    marketJobId: number;
    boothCode: string;
    finalStallAmount: string | null;
    financialized: boolean;
    financial?: { workerPayoutTotal: string; fundAmount: string };
  },
) {
  const booth = await tx.boothJob.create({
    data: {
      ticketJobId: input.ticketJobId,
      marketJobId: input.marketJobId,
      boothCode: input.boothCode,
      finalStallAmount: input.finalStallAmount,
      financializedAt: input.financialized ? new Date() : null,
    },
  });
  const product = await tx.ticketProduct.create({
    data: {
      ticketId: booth.id,
      productCode: "PRD1",
      productName: "Product 1",
      packageCode: "PKG1",
      packageName: "Package 1",
      quantity: "10.00",
      requiredWorkerCountSnapshot: 1,
    },
  });

  if (input.financial) {
    await tx.ticketProductFinancial.create({
      data: {
        ticketProductId: product.id,
        confirmedQuantity: "10.00",
        workerCount: 1,
        workerPayoutTotal: input.financial.workerPayoutTotal,
        fundAmount: input.financial.fundAmount,
        finalizedAt: new Date(),
        shirtColorSnapshot: "NAVY",
      },
    });
  }
}

/* -------------------------------------- Tests -------------------------------------- */

test(
  "adminJobsRepository.listTicketJobs aggregates the Work History Summary over the whole filtered set, independent of page",
  {
    skip: runDbTests
      ? false
      : "Set RUN_DB_TESTS=1 and run PostgreSQL migration before this test.",
  },
  async () => {
    assertSafeTestDatabaseUrl();

    const suffix = `WHS-${Date.now().toString(36)}`;

    await runRollbackTest(async (tx) => {
      const completed = await createTicketJobWithMarket(tx, `${suffix}-1`, VEHICLE_JOB_STATUS.COMPLETED);
      const cancelled = await createTicketJobWithMarket(tx, `${suffix}-2`, VEHICLE_JOB_STATUS.CANCELLED);

      await createTicketJobWithMarket(tx, `${suffix}-3`, VEHICLE_JOB_STATUS.WAIT);
      await createBoothWithProduct(tx, {
        ticketJobId: completed.ticketJob.id,
        marketJobId: completed.marketJob.id,
        boothCode: "B1",
        finalStallAmount: "100.50",
        financialized: true,
        financial: { workerPayoutTotal: "70.25", fundAmount: "30.2500" },
      });
      // แผงที่ยังไม่ปิดยอดต้องไม่ถูกนับในยอดแผง
      await createBoothWithProduct(tx, {
        ticketJobId: completed.ticketJob.id,
        marketJobId: completed.marketJob.id,
        boothCode: "B2",
        finalStallAmount: "50.00",
        financialized: false,
      });
      await createBoothWithProduct(tx, {
        ticketJobId: cancelled.ticketJob.id,
        marketJobId: cancelled.marketJob.id,
        boothCode: "B1",
        finalStallAmount: "20.00",
        financialized: true,
        financial: { workerPayoutTotal: "14.00", fundAmount: "6.0001" },
      });

      const pages = await Promise.all(
        [1, 2, 3].map((page) =>
          adminJobsRepository.listTicketJobs({ search: suffix, page, limit: 1 }, tx),
        ),
      );
      const filtered = await adminJobsRepository.listTicketJobs(
        { search: suffix, history_status: "COMPLETED", page: 1, limit: 5 },
        tx,
      );
      const empty = await adminJobsRepository.listTicketJobs(
        { search: `${suffix}-NONE`, page: 1, limit: 5 },
        tx,
      );
      const unpaged = await adminJobsRepository.listTicketJobs({ search: suffix }, tx);

      for (const page of pages) {
        assert.equal(page.data.length, 1);
        assert.equal(page.total, 3);
        assert.ok(page.summary);
        assert.equal(page.summary.total, 3);
        assert.equal(page.summary.completed, 1);
        assert.equal(page.summary.cancelled, 1);
        assert.equal(page.summary.stall_fee_total.toFixed(2), "120.50");
        assert.equal(page.summary.worker_income_total.toFixed(2), "84.25");
        assert.equal(page.summary.fund_total.toFixed(4), "36.2501");
      }

      assert.ok(filtered.summary);
      assert.equal(filtered.summary.total, 1);
      assert.equal(filtered.summary.stall_fee_total.toFixed(2), "100.50");
      assert.equal(filtered.summary.worker_income_total.toFixed(2), "70.25");
      assert.equal(filtered.summary.fund_total.toFixed(4), "30.2500");
      assert.ok(empty.summary);
      assert.equal(empty.summary.total, 0);
      assert.equal(empty.summary.stall_fee_total.toFixed(2), "0.00");
      assert.equal(unpaged.summary, undefined);
      assert.equal(unpaged.data.length, 3);
    });
  }
);

test(
  "adminJobsRepository.listGateTicketUpdatesByTicketJobIds returns only UPDATED Gate edits grouped per vehicle in time order with Gate name, TicketNo and stored change summary/details",
  {
    skip: runDbTests
      ? false
      : "Set RUN_DB_TESTS=1 and run PostgreSQL migration before this test.",
  },
  async () => {
    assertSafeTestDatabaseUrl();

    const suffix = `GTU-${Date.now().toString(36)}`;

    await runRollbackTest(async (tx) => {
      const first = await createTicketJobWithMarket(tx, `${suffix}-1`, VEHICLE_JOB_STATUS.WORKING);
      const second = await createTicketJobWithMarket(tx, `${suffix}-2`, VEHICLE_JOB_STATUS.WORKING);
      const outside = await createTicketJobWithMarket(tx, `${suffix}-3`, VEHICLE_JOB_STATUS.WORKING);
      const gateClient = await tx.gateClient.create({
        data: { clientId: `gate-${suffix}`, name: "Gate Client 02", secretHash: "hash" },
      });
      // log แก้ตั๋วทุกแถวบันทึกสรุปและรายละเอียดการแก้ไว้เสมอ
      const changeSummary = { MarketChanged: false, DropoffPointChanged: true, Added: [], Removed: [], Updated: [], Unchanged: [], PreviousWorkerCount: 1, WorkerCount: 1 };
      const changeDetails = [{ Type: "DROPOFF_POINT_CHANGED", Before: "Gate 1", After: "Gate 2" }];
      const createLog = (
        ticketJobId: number,
        marketJobId: number,
        requestType: string,
        result: string | null,
        createdAt: Date,
        gateClientId: number | null,
      ) =>
        tx.gateRequestLog.create({
          data: {
            gateTransactionRef: `REF-${suffix}-${ticketJobId}-${createdAt.getTime()}-${requestType}-${result}`,
            ticketJobId,
            marketJobId,
            requestType,
            result,
            gateNo: "G02",
            gateClientId,
            payloadSnapshot: {},
            changeSummary,
            changeDetails,
            createdAt,
          },
        });

      const later = await createLog(first.ticketJob.id, first.marketJob.id, "UPDATE", "UPDATED", new Date("2026-10-14T09:00:00.000Z"), gateClient.id);
      const earlier = await createLog(first.ticketJob.id, first.marketJob.id, "UPDATE", "UPDATED", new Date("2026-10-14T08:30:00.000Z"), gateClient.id);

      await createLog(first.ticketJob.id, first.marketJob.id, "UPDATE", "NO_CHANGE", new Date("2026-10-14T08:45:00.000Z"), gateClient.id);
      await createLog(first.ticketJob.id, first.marketJob.id, "CREATE", null, new Date("2026-10-14T08:00:00.000Z"), gateClient.id);

      const withoutClient = await createLog(second.ticketJob.id, second.marketJob.id, "UPDATE", "UPDATED", new Date("2026-10-14T10:00:00.000Z"), null);

      await createLog(outside.ticketJob.id, outside.marketJob.id, "UPDATE", "UPDATED", new Date("2026-10-14T10:00:00.000Z"), gateClient.id);

      const result = await adminJobsRepository.listGateTicketUpdatesByTicketJobIds(
        [first.ticketJob.id, second.ticketJob.id],
        tx,
      );

      assert.deepEqual([...result.keys()].sort(), [first.ticketJob.id, second.ticketJob.id].sort());
      assert.deepEqual(result.get(first.ticketJob.id), [
        { id: earlier.id, gate_no: "G02", gate_client_name: "Gate Client 02", ticket_no: first.marketJob.ticketNo, change_summary: changeSummary, change_details: changeDetails, created_at: "2026-10-14T08:30:00.000Z" },
        { id: later.id, gate_no: "G02", gate_client_name: "Gate Client 02", ticket_no: first.marketJob.ticketNo, change_summary: changeSummary, change_details: changeDetails, created_at: "2026-10-14T09:00:00.000Z" },
      ]);
      assert.deepEqual(result.get(second.ticketJob.id), [
        { id: withoutClient.id, gate_no: "G02", gate_client_name: null, ticket_no: second.marketJob.ticketNo, change_summary: changeSummary, change_details: changeDetails, created_at: "2026-10-14T10:00:00.000Z" },
      ]);
    });
  },
);
