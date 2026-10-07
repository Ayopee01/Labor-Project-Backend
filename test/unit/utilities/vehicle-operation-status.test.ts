// Import Library
import assert from "node:assert/strict";
import { test } from "node:test";
// Import Utils
import { countScannedAssignments, resolveVehicleOperationStatus, toDriverOperationStatus, type VehicleOperationStatusInput } from "../../../src/utils/vehicle-operation-status";

/* -------------------------------------- Test Helpers -------------------------------------- */

// Function สร้าง input งานรถที่เปิด dispatch แล้ว ทีม 2 คน (override เฉพาะค่าที่ต้องการทดสอบ)
function buildInput(overrides: Partial<VehicleOperationStatusInput> = {}): VehicleOperationStatusInput {
  return {
    status: "WORKING",
    dispatch_now: true,
    workers_required: 2,
    unfilled_slot_count: 0,
    active_assignment_count: 0,
    scanned_assignment_count: 0,
    has_rejected_booth: false,
    ...overrides,
  };
}

/* -------------------------------------- Resolver Tests -------------------------------------- */

test("resolveVehicleOperationStatus stays ready_now while the current team accepted but has not all scanned", () => {
  assert.equal(
    resolveVehicleOperationStatus(buildInput({ active_assignment_count: 2, scanned_assignment_count: 0 })),
    "ready_now",
  );
  assert.equal(
    resolveVehicleOperationStatus(buildInput({ active_assignment_count: 2, scanned_assignment_count: 1 })),
    "ready_now",
  );
});

test("resolveVehicleOperationStatus becomes working once the last member of the current team scans", () => {
  assert.equal(
    resolveVehicleOperationStatus(buildInput({ active_assignment_count: 2, scanned_assignment_count: 2 })),
    "working",
  );
});

test("resolveVehicleOperationStatus keeps wait_worker while the current team is short of active assignments", () => {
  assert.equal(
    resolveVehicleOperationStatus(buildInput({ active_assignment_count: 1, scanned_assignment_count: 1 })),
    "wait_worker",
  );
});

test("resolveVehicleOperationStatus compares scans against workers_required minus unfilled slots", () => {
  assert.equal(
    resolveVehicleOperationStatus(
      buildInput({ workers_required: 3, unfilled_slot_count: 1, active_assignment_count: 2, scanned_assignment_count: 2 }),
    ),
    "working",
  );
  assert.equal(
    resolveVehicleOperationStatus(
      buildInput({ workers_required: 3, unfilled_slot_count: 1, active_assignment_count: 2, scanned_assignment_count: 1 }),
    ),
    "ready_now",
  );
});

test("resolveVehicleOperationStatus keeps RELEASED as working and dispatch_now=false as wait_unload", () => {
  assert.equal(resolveVehicleOperationStatus(buildInput({ status: "RELEASED" })), "working");
  assert.equal(
    resolveVehicleOperationStatus(
      buildInput({ status: "WAIT", dispatch_now: false, active_assignment_count: 2, scanned_assignment_count: 2 }),
    ),
    "wait_unload",
  );
});

test("toDriverOperationStatus maps the current-team readiness to DISPATCH_NOW and IN_PROGRESS", () => {
  assert.equal(
    toDriverOperationStatus(
      resolveVehicleOperationStatus(buildInput({ active_assignment_count: 2, scanned_assignment_count: 1 })),
    ),
    "DISPATCH_NOW",
  );
  assert.equal(
    toDriverOperationStatus(
      resolveVehicleOperationStatus(buildInput({ active_assignment_count: 2, scanned_assignment_count: 2 })),
    ),
    "IN_PROGRESS",
  );
  assert.equal(toDriverOperationStatus(resolveVehicleOperationStatus(buildInput({ status: "RELEASED" }))), "IN_PROGRESS");
});

/* -------------------------------------- Scanned Count Tests -------------------------------------- */

test("countScannedAssignments counts scanned statuses only and ignores the cancelled previous team", () => {
  assert.equal(
    countScannedAssignments([
      { status: "CANCELLED" },
      { status: "CANCELLED" },
      { status: "ACCEPTED" },
      { status: "SCANNED" },
      { status: "WORKING" },
    ]),
    2,
  );
});
