import assert from "node:assert/strict";
import { test } from "node:test";

import { TICKET_STATUS, VEHICLE_JOB_STATUS } from "../../../src/constants/status";
import * as gateService from "../../../src/services/gate.service";
import type { DbConnection } from "../../../src/types/shared/common.type";
import { assertSafeTestDatabaseUrl } from "../../setup/test-env";

/* -------------------------------------- Config -------------------------------------- */

const runDbTests = process.env.RUN_DB_TESTS === "1";

/* -------------------------------------- Helpers -------------------------------------- */

// Regression net for gate.service.ts createOrAppendGateBusinessTicket — owns the business decisions
// (dispatchNow/vehicleStatus, canReopenDispatch/shouldUpdateVehicle, marketStatus, append-vs-create,
// SUM-of-active-MarketJobs) that used to live inside gate.repository.ts createTicketJobFromGate.
// Route-level tests (test/routes/gate.routes.test.ts) mock the repository layer entirely, so they
// cannot catch a regression in the real Prisma lock/read/decide/write sequence — only this test can.
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

function buildProduct(overrides: Partial<Parameters<typeof gateService.createOrAppendGateBusinessTicket>[0]["markets"][number]["booths"][number]["products"][number]> = {}) {
  return {
    productCode: "PRD1",
    productFullCode: "PRD1-FULL",
    productName: "Test Product",
    packageCode: "PKG1",
    packageName: "Test Package",
    quantity: 10,
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

/* -------------------------------------- Tests -------------------------------------- */

test(
  "gate.service.createOrAppendGateBusinessTicket preserves dispatch/status/MAX/SUM business rules against real PostgreSQL",
  {
    skip: runDbTests
      ? false
      : "Set RUN_DB_TESTS=1 and run PostgreSQL migration before this test.",
  },
  async () => {
    assertSafeTestDatabaseUrl();

    const suffix = Date.now().toString(36);
    const ticketNumber = `GATE-IT-${suffix}`;

    await runRollbackTest(async (tx) => {
      // --- Scenario 1: brand-new TicketJob + MarketJob, dispatch_now = false ---
      const first = await gateService.createOrAppendGateBusinessTicket(
        {
          ticketNumber,
          license_plate: "1กก-1234",
          license_plate_province: "Bangkok",
          vehicle_type: "Truck",
          dispatch_now: false,
          markets: [
            {
              ticketNo: `TN1-${suffix}`,
              ticket_created_at: new Date(),
              booth_count: 1,
              gate_transaction_ref: `ref1-${suffix}`,
              workers_required: 2,
              marketCode: "MKT1",
              marketName: "Market One",
              dropoff_point: "Zone A",
              booths: [
                {
                  boothCode: "B1",
                  boothName: "Booth 1",
                  products: [buildProduct()],
                },
              ],
            },
          ],
        },
        {},
        tx
      );

      assert.equal(first.ticketJob.status, VEHICLE_JOB_STATUS.WAIT);
      assert.equal(first.ticketJob.dispatch_now, false);
      assert.equal(first.ticketJob.workers_required, 2);
      assert.ok(first.ticketJob.tickets_closed_at, "ticketsClosedAt should be set on first Ticket");
      assert.equal(first.marketJob.status, TICKET_STATUS.WAIT);
      assert.equal(first.marketJob.workers_required, 2);
      assert.equal(first.marketJob.booth_count, 1);

      // --- Scenario 2: append a new booth into the SAME active MarketJob with a HIGHER
      // workers_required — must take MAX(existing, requested), not replace or add ---
      const appended = await gateService.createOrAppendGateBusinessTicket(
        {
          ticketNumber,
          license_plate: "1กก-1234",
          license_plate_province: "Bangkok",
          vehicle_type: "Truck",
          dispatch_now: false,
          existingMarketJobId: first.marketJob.id,
          markets: [
            {
              ticketNo: `TN1-${suffix}`,
              ticket_created_at: new Date(),
              booth_count: 1,
              gate_transaction_ref: `ref2-${suffix}`,
              workers_required: 5,
              marketCode: "MKT1",
              marketName: "Market One",
              dropoff_point: "Zone A",
              booths: [
                {
                  boothCode: "B2",
                  boothName: "Booth 2",
                  products: [buildProduct()],
                },
              ],
            },
          ],
        },
        {},
        tx
      );

      assert.equal(appended.marketJob.id, first.marketJob.id, "append must reuse the existing MarketJob row");
      assert.equal(appended.marketJob.booth_count, 2, "booth_count must increment, not reset");
      assert.equal(
        appended.marketJob.workers_required,
        5,
        "MAX(2, 5) must win over the previous MarketJob workers_required"
      );
      // Only one active MarketJob so far -> TicketJob.workers_required (SUM) must follow it to 5
      assert.equal(appended.ticketJob.workers_required, 5);

      // --- Scenario 3: a second, independent Business Ticket (different TicketNo) under the SAME
      // TicketNumber -> TicketJob.workers_required must be the SUM across active MarketJobs, not MAX ---
      const secondTicket = await gateService.createOrAppendGateBusinessTicket(
        {
          ticketNumber,
          license_plate: "1กก-1234",
          license_plate_province: "Bangkok",
          vehicle_type: "Truck",
          dispatch_now: false,
          markets: [
            {
              ticketNo: `TN2-${suffix}`,
              ticket_created_at: new Date(),
              booth_count: 1,
              gate_transaction_ref: `ref3-${suffix}`,
              workers_required: 3,
              marketCode: "MKT2",
              marketName: "Market Two",
              dropoff_point: "Zone B",
              booths: [
                {
                  boothCode: "B3",
                  boothName: "Booth 3",
                  products: [buildProduct()],
                },
              ],
            },
          ],
        },
        {},
        tx
      );

      assert.notEqual(secondTicket.marketJob.id, first.marketJob.id, "must create a new MarketJob for a new TicketNo");
      assert.equal(
        secondTicket.ticketJob.workers_required,
        8,
        "TicketJob.workers_required must SUM active MarketJobs (5 + 3), never MAX"
      );
      assert.equal(secondTicket.ticketJob.expected_ticket_count, 2, "2 active MarketJobs exist under this TicketJob");
      // dispatch_now was never requested -> vehicle must stay WAIT, unaffected by the new ticket
      assert.equal(secondTicket.ticketJob.status, VEHICLE_JOB_STATUS.WAIT);

      // --- Scenario 4: a third Business Ticket with dispatch_now = true must REOPEN dispatch on a
      // WAIT vehicle (canReopenDispatch) and cascade the TicketJob + new MarketJob to WORKING ---
      const dispatched = await gateService.createOrAppendGateBusinessTicket(
        {
          ticketNumber,
          license_plate: "1กก-1234",
          license_plate_province: "Bangkok",
          vehicle_type: "Truck",
          dispatch_now: true,
          markets: [
            {
              ticketNo: `TN3-${suffix}`,
              ticket_created_at: new Date(),
              booth_count: 1,
              gate_transaction_ref: `ref4-${suffix}`,
              workers_required: 1,
              marketCode: "MKT3",
              marketName: "Market Three",
              dropoff_point: "Zone C",
              booths: [
                {
                  boothCode: "B4",
                  boothName: "Booth 4",
                  products: [buildProduct()],
                },
              ],
            },
          ],
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
        dispatched.marketJob.status,
        VEHICLE_JOB_STATUS.WORKING,
        "a MarketJob created while the vehicle is WORKING/dispatching must itself be WORKING"
      );
      assert.equal(dispatched.ticketJob.workers_required, 9, "SUM must now include the 3rd ticket (5 + 3 + 1)");
    });
  }
);
