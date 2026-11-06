// Import Library
import assert from "node:assert/strict";
import { test } from "node:test";
// Import Middlewares
import { toPascalCasePayload } from "../../../src/middlewares/api-case.middleware";
// Import Types
import type { TicketJobAssignmentDto } from "../../../src/types/worker.type";
// Import Utils
import { buildAdminScanDeadlineWarningPayload } from "../../../src/utils/worker-payload";

/* -------------------------------------- Fixtures -------------------------------------- */

const assignment = {
  id: 10,
  vehicle_job_id: 20,
  worker_id: 30,
  status: "ACCEPTED",
  scan_deadline_at: "2026-10-09T08:30:00.000Z",
} as TicketJobAssignmentDto;

/* -------------------------------------- Tests -------------------------------------- */

test("ASSIGNMENT_SCAN_DEADLINE_WARNING admin payload carries worker and vehicle snapshot of the same assignment", () => {
  const payload = toPascalCasePayload(
    buildAdminScanDeadlineWarningPayload({
      assignment,
      ticketJob: { ticket_number: "20261009000001", license_plate: "1กข-1234" },
      worker: { labor_code: "W001", full_name: "สมชาย ใจดี", coat_no: "42" },
      workerStatus: "ASSIGNED",
      remainingSeconds: 120,
      warningBeforeMinutes: 2,
    }),
  ) as Record<string, unknown>;

  assert.equal(payload.TicketNumber, "20261009000001");
  assert.equal(payload.WorkerCode, "W001");
  assert.equal(payload.WorkerName, "สมชาย ใจดี");
  assert.equal(payload.ShirtNumber, "42");
  assert.equal(payload.PlateNo, "1กข-1234");
  assert.equal(payload.ScanDeadlineAt, "2026-10-09T08:30:00.000Z");
  assert.equal(payload.RemainingSeconds, 120);
  assert.equal(payload.AssignmentStatus, "ACCEPTED");
  assert.equal(payload.WorkerStatus, "ASSIGNED");
  assert.equal(payload.WarningBeforeMinutes, 2);
});

test("ASSIGNMENT_SCAN_DEADLINE_WARNING admin payload falls back to WorkerCode for name and null for missing snapshot fields", () => {
  const withoutName = buildAdminScanDeadlineWarningPayload({
    assignment,
    ticketJob: { ticket_number: "20261009000001", license_plate: "1กข-1234" },
    worker: { labor_code: "W001", full_name: null, coat_no: null },
    workerStatus: "ASSIGNED",
    remainingSeconds: 60,
    warningBeforeMinutes: 2,
  });
  const missing = buildAdminScanDeadlineWarningPayload({
    assignment,
    ticketJob: null,
    worker: null,
    workerStatus: "ASSIGNED",
    remainingSeconds: 60,
    warningBeforeMinutes: 2,
  });

  assert.equal(withoutName.worker_name, "W001");
  assert.equal(withoutName.shirt_number, null);
  assert.equal(missing.ticketNumber, null);
  assert.equal(missing.worker_code, null);
  assert.equal(missing.worker_name, null);
  assert.equal(missing.shirt_number, null);
  assert.equal(missing.plate_no, null);
});
