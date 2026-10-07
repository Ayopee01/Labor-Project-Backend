// Import Library
import assert from "node:assert/strict";
import { test } from "node:test";
// Import Config
import { TICKET_STATUS, VEHICLE_JOB_STATUS } from "../../../src/constants/status";
// Import Services
import * as gateService from "../../../src/services/gate.service";
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

// Function สร้างข้อมูลสินค้าสำหรับ Gate
function buildProduct(overrides: Partial<Parameters<typeof gateService.createGateBusinessTickets>[0]["markets"][number]["booths"][number]["products"][number]> = {}) {
  return {
    productCode: "PRD1",
    productFullCode: "PRD1-FULL",
    productName: "Test Product",
    packageCode: "PKG1",
    packageName: "Test Package",
    quantity: 10,
    requiredWorkerCount: 1,
    packageWeightSnapshot: "20.00",
    rateIdSnapshot: 1,
    sourceRateIdSnapshot: 1,
    rateMarketCode: "MKT1",
    rateSource: "MARKET_RATE" as const,
    weightRangeName: "10-30",
    weightMinSnapshot: "10.00",
    weightMaxSnapshot: "30.00",
    stallRateSnapshot: "5.00",
    laborRateSnapshot: "3.00",
    rateSnapshotAt: new Date(),
    ...overrides,
  };
}

// Function สร้างตั๋ว 1 ตลาดสำหรับ Gate
function buildMarket(
  suffix: string,
  ticketNo: string,
  marketCode: string,
  workersRequired: number,
  boothCode: string
) {
  return {
    ticketNo: `${ticketNo}-${suffix}`,
    ticket_created_at: new Date(),
    booth_count: 1,
    gate_transaction_ref: `ref-${ticketNo}-${suffix}`,
    workers_required: workersRequired,
    marketCode,
    marketName: `Market ${marketCode}`,
    dropoff_point: "Zone A",
    booths: [
      {
        boothCode,
        boothName: `Booth ${boothCode}`,
        products: [buildProduct({ requiredWorkerCount: workersRequired })],
      },
    ],
  };
}

/* -------------------------------------- Tests -------------------------------------- */

test(
  "gate.service.createGateBusinessTickets preserves dispatch/status/MAX/SUM business rules against real PostgreSQL",
  {
    skip: runDbTests
      ? false
      : "Set RUN_DB_TESTS=1 and run PostgreSQL migration before this test.",
  },
  async () => {
    assertSafeTestDatabaseUrl();

    const suffix = Date.now().toString(36);
    const ticketNumber = `GATE-IT-${suffix}`;
    const vehicle = {
      ticketNumber,
      license_plate: "1กก-1234",
      license_plate_province: "Bangkok",
      vehicle_type: "Truck",
      vehicle_type_code: "TRUCK",
      gate_no: "G01",
      gate_client_id: null,
    };

    await runRollbackTest(async (tx) => {
      // Scenario 1: request เดียวสร้าง 2 ตลาด dispatch_now = false -> SUM ของ workers_required ทุกตั๋ว
      const first = await gateService.createGateBusinessTickets(
        {
          ...vehicle,
          dispatch_now: false,
          markets: [
            buildMarket(suffix, "TN1", "MKT1", 2, "B1"),
            buildMarket(suffix, "TN2", "MKT2", 3, "B2"),
          ],
        },
        {},
        tx
      );

      assert.equal(first.ticketJob.status, VEHICLE_JOB_STATUS.WAIT);
      assert.equal(first.ticketJob.dispatch_now, false);
      assert.equal(first.ticketJob.vehicle_type_code, "TRUCK");
      assert.equal(first.ticketJob.workers_required, 5, "TicketJob.workers_required must SUM active tickets (2 + 3)");
      assert.ok(first.ticketJob.tickets_closed_at, "ticketsClosedAt should be set on first request");
      assert.equal(first.marketJobs.length, 2);
      assert.equal(first.marketJobs[0].status, TICKET_STATUS.WAIT);
      assert.equal(first.marketJobs[0].gate_no, "G01");
      assert.equal(first.marketJobs[1].workers_required, 3);

      // Scenario 2: TicketNo ที่ยัง active ซ้ำ ต้องปฏิเสธ (แก้ไขผ่าน PUT เท่านั้น)
      await assert.rejects(
        gateService.createGateBusinessTickets(
          {
            ...vehicle,
            dispatch_now: false,
            markets: [buildMarket(suffix, "TN1", "MKT1", 4, "B9")],
          },
          {},
          tx
        ),
        (error: unknown) => (error as { code?: string }).code === "GATE_TICKET_ALREADY_EXISTS"
      );

      // Scenario 3: ตั๋วใหม่ dispatch_now = true ต้องเปิด dispatch รถ WAIT และ cascade เป็น WORKING
      const dispatched = await gateService.createGateBusinessTickets(
        {
          ...vehicle,
          dispatch_now: true,
          markets: [buildMarket(suffix, "TN3", "MKT3", 1, "B3")],
        },
        {},
        tx
      );

      assert.equal(dispatched.ticketJob.dispatch_now, true);
      assert.equal(
        dispatched.ticketJob.status,
        VEHICLE_JOB_STATUS.WORKING,
        "dispatch_now=true on a WAIT vehicle must reopen it to WORKING"
      );
      assert.equal(
        dispatched.marketJobs[0].status,
        VEHICLE_JOB_STATUS.WORKING,
        "a ticket created while the vehicle is WORKING/dispatching must itself be WORKING"
      );
      assert.equal(dispatched.ticketJob.workers_required, 6, "SUM must now include the 3rd ticket (2 + 3 + 1)");
    });
  }
);
