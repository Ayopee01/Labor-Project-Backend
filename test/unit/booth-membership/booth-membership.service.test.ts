// Import Library
import assert from "node:assert/strict";
import { test } from "node:test";
// Import Services
import { estimateBoothWorkerAmount, isPendingBoothMember, resolveBoothMemberTicketWorkerIds } from "../../../src/services/shared/booth-membership.service";
// Import Types
import type { BoothMembershipRecord } from "../../../src/types/shared/booth-membership.type";

/* -------------------------------------- Helpers -------------------------------------- */

// Function สร้างแผงทดสอบ (roster A=1, B=2, C=3 เป็น ticket_worker 11, 12, 13 ทุกคน WORKING)
function buildBooth(overrides: Partial<BoothMembershipRecord> = {}): BoothMembershipRecord {
  return {
    id: 1,
    booth_code: "B1",
    booth_name: null,
    status: "WORKING",
    market_job_id: 10,
    ticket_no: "T1",
    market_name: "Market",
    roster: [1, 2, 3].map((workerId) => ({
      ticket_worker_id: workerId + 10,
      worker_id: workerId,
      status: "WORKING",
    })),
    booth_snapshot_ticket_worker_ids: [],
    excluded_ticket_worker_ids: [],
    included_worker_ids: [],
    latest_submission: null,
    products: [],
    ...overrides,
  };
}

/* -------------------------------------- Tests -------------------------------------- */

test("resolveBoothMemberTicketWorkerIds uses the WORKING roster minus booth exclusions before the booth is submitted", () => {
  const booth = buildBooth({ excluded_ticket_worker_ids: [12] });

  assert.deepEqual(resolveBoothMemberTicketWorkerIds(booth), [11, 13]);
});

test("resolveBoothMemberTicketWorkerIds keeps the submission list while waiting for the vendor even if the roster changed", () => {
  const booth = buildBooth({
    status: "DELIVERED",
    roster: [{ ticket_worker_id: 11, worker_id: 1, status: "CANCELLED" }],
    latest_submission: { created_at: "2026-10-15T00:00:00.000Z", snapshot_ticket_worker_ids: [11, 12] },
  });

  assert.deepEqual(resolveBoothMemberTicketWorkerIds(booth), [11, 12]);
});

test("resolveBoothMemberTicketWorkerIds uses the confirm snapshot for a completed booth", () => {
  const booth = buildBooth({
    status: "COMPLETED",
    booth_snapshot_ticket_worker_ids: [11, 13],
    latest_submission: { created_at: "2026-10-15T00:00:00.000Z", snapshot_ticket_worker_ids: [11, 12, 13] },
    excluded_ticket_worker_ids: [13],
  });

  assert.deepEqual(resolveBoothMemberTicketWorkerIds(booth), [11]);
});

test("resolveBoothMemberTicketWorkerIds for a rejected booth keeps the submission list, drops unpaid removals and adds only picked workers who scanned in", () => {
  const booth = buildBooth({
    status: "REJECT",
    roster: [
      { ticket_worker_id: 11, worker_id: 1, status: "WORKING" },
      { ticket_worker_id: 12, worker_id: 2, status: "CANCELLED" },
      { ticket_worker_id: 13, worker_id: 3, status: "CANCELLED" },
      { ticket_worker_id: 14, worker_id: 4, status: "WORKING" },
      { ticket_worker_id: 15, worker_id: 5, status: "WORKING" },
    ],
    latest_submission: { created_at: "2026-10-15T00:00:00.000Z", snapshot_ticket_worker_ids: [11, 12, 13] },
    // B (12) ถูกถอดแบบไม่ให้เงิน, C (13) ถูกถอดแบบให้เงิน, D (4) ถูกเลือกเข้าแผง, E (5) ไม่ได้ถูกเลือก
    excluded_ticket_worker_ids: [12],
    included_worker_ids: [4],
  });

  assert.deepEqual(resolveBoothMemberTicketWorkerIds(booth), [11, 13, 14]);
});

test("isPendingBoothMember waits for every new worker on an unsubmitted booth but only for picked workers on a rejected booth", () => {
  const unsubmitted = buildBooth({ excluded_ticket_worker_ids: [13] });
  const rejected = buildBooth({ status: "REJECT", included_worker_ids: [7] });

  // คนใหม่ยังไม่มี roster
  assert.equal(isPendingBoothMember(unsubmitted, 9), true);
  // คนที่ถูกถอดจากแผงนี้ไม่ต้องรอ
  assert.equal(isPendingBoothMember(unsubmitted, 3), false);
  assert.equal(isPendingBoothMember(rejected, 7), true);
  assert.equal(isPendingBoothMember(rejected, 9), false);
});

test("estimateBoothWorkerAmount uses saved payments after financialization and the same formula before it", () => {
  const confirmed = buildBooth({
    status: "COMPLETED",
    booth_snapshot_ticket_worker_ids: [11, 12],
    products: [
      { labor_fee_raw: "9.0000", payments: null },
      { labor_fee_raw: "3.6000", payments: null },
    ],
  });
  const financialized = buildBooth({
    status: "COMPLETED",
    booth_snapshot_ticket_worker_ids: [11, 12],
    products: [{ labor_fee_raw: "9.0000", payments: [{ ticket_worker_id: 11, final_amount: "7.00" }] }],
  });

  // 9.00 / 2 = 4.5 -> 4 และ 3.60 / 2 = 1.8 -> 1
  assert.equal(estimateBoothWorkerAmount(confirmed, 11)?.toFixed(2), "5.00");
  assert.equal(estimateBoothWorkerAmount(confirmed, 13)?.toFixed(2), "0.00");
  assert.equal(estimateBoothWorkerAmount(financialized, 11)?.toFixed(2), "7.00");
  assert.equal(estimateBoothWorkerAmount(buildBooth({ status: "DELIVERED" }), 11), null);
});
