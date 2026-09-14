import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import Module = require("node:module");

import type { SecurityAuditLogDto, SecurityAuditLogWriteInput } from "../../../src/types/shared/security-audit-log.type";

/* -------------------------------------- Module Loader Patch -------------------------------------- */
// Mock security-audit-log repository through Module._load before loading the service — เพื่อทดสอบ
// contract ของ writeSecurityAuditLog (ต้อง throw ต่อ ไม่ swallow ให้ withTransaction ของจริง rollback
// ได้) และ writeSecurityAuditLogBestEffort (ต้อง swallow) โดยไม่ต้องพึ่ง DB จริง

type ModuleLoad = (
  request: string,
  parent: NodeModule | null | undefined,
  isMain: boolean
) => unknown;

type ModuleWithLoad = typeof Module & { _load: ModuleLoad };

const moduleWithLoad = Module as ModuleWithLoad;
const originalLoad = moduleWithLoad._load;

let createBehavior: (input: SecurityAuditLogWriteInput) => Promise<SecurityAuditLogDto> = async (
  input
) => ({
  id: 1,
  event_type: input.event_type,
  outcome: input.outcome,
  actor_type: input.actor_type ?? null,
  actor_account_id: input.actor_account_id ?? null,
  actor_worker_id: input.actor_worker_id ?? null,
  actor_username: input.actor_username ?? null,
  actor_full_name: input.actor_full_name ?? null,
  session_id: input.session_id ?? null,
  request_id: input.request_id ?? null,
  ip_address: input.ip_address ?? null,
  user_agent: input.user_agent ?? null,
  failure_code: input.failure_code ?? null,
  metadata: input.metadata ?? null,
  created_at: new Date().toISOString(),
});

let deleteOlderThanCalls: Date[] = [];
let deleteOlderThanReturnCount = 0;

const securityAuditLogRepositoryStub = {
  create: async (input: SecurityAuditLogWriteInput) => createBehavior(input),
  deleteOlderThan: async (cutoff: Date) => {
    deleteOlderThanCalls.push(cutoff);
    return deleteOlderThanReturnCount;
  },
};

moduleWithLoad._load = function patchedLoad(
  request: string,
  parent: NodeModule | null | undefined,
  isMain: boolean
) {
  if (request === "../../repositories/shared/security-audit-log.repository") {
    return securityAuditLogRepositoryStub;
  }

  return originalLoad.call(moduleWithLoad, request, parent, isMain);
};

after(() => {
  moduleWithLoad._load = originalLoad;
});

// Function loads service after Module._load is patched
const securityAuditLogService =
  require("../../../src/services/shared/security-audit-log.service") as typeof import("../../../src/services/shared/security-audit-log.service");

beforeEach(() => {
  deleteOlderThanCalls = [];
  deleteOlderThanReturnCount = 0;
  createBehavior = async (input) => ({
    id: 1,
    event_type: input.event_type,
    outcome: input.outcome,
    actor_type: input.actor_type ?? null,
    actor_account_id: input.actor_account_id ?? null,
    actor_worker_id: input.actor_worker_id ?? null,
    actor_username: input.actor_username ?? null,
    actor_full_name: input.actor_full_name ?? null,
    session_id: input.session_id ?? null,
    request_id: input.request_id ?? null,
    ip_address: input.ip_address ?? null,
    user_agent: input.user_agent ?? null,
    failure_code: input.failure_code ?? null,
    metadata: input.metadata ?? null,
    created_at: new Date().toISOString(),
  });
});

/* -------------------------------------- writeSecurityAuditLog (must NOT swallow) -------------------------------------- */

test("writeSecurityAuditLog propagates a repository write failure instead of swallowing it, so the caller's withTransaction rolls back the whole mutation together with the log (27.12 item 3)", async () => {
  createBehavior = async () => {
    throw new Error("simulated DB write failure");
  };

  await assert.rejects(
    () =>
      securityAuditLogService.writeSecurityAuditLog(
        {
          event_type: "admin_account_updated",
          outcome: "success",
        },
        { transaction: true } as never
      ),
    /simulated DB write failure/
  );
});

test("writeSecurityAuditLog succeeds silently when the repository write succeeds", async () => {
  await assert.doesNotReject(() =>
    securityAuditLogService.writeSecurityAuditLog(
      { event_type: "admin_account_updated", outcome: "success" },
      { transaction: true } as never
    )
  );
});

/* -------------------------------------- writeSecurityAuditLogBestEffort (must swallow) -------------------------------------- */

test("writeSecurityAuditLogBestEffort swallows a repository write failure and does not throw, so a rejected login still returns its correct error response", async () => {
  createBehavior = async () => {
    throw new Error("simulated DB write failure");
  };

  await assert.doesNotReject(() =>
    securityAuditLogService.writeSecurityAuditLogBestEffort({
      event_type: "auth_login_failed",
      outcome: "failure",
    })
  );
});

/* -------------------------------------- diffChangedFields -------------------------------------- */

test("diffChangedFields returns only the fields that actually changed, using null for a previously-undefined value, and null when nothing changed", () => {
  const before = { full_name: "Old Name", email: "old@example.com", phone: undefined as string | undefined };
  const after = { full_name: "New Name", email: "old@example.com", phone: "081-000-0000" };

  const diff = securityAuditLogService.diffChangedFields(before, after, [
    "full_name",
    "email",
    "phone",
  ]);

  assert.deepEqual(diff, {
    before: { full_name: "Old Name", phone: null },
    after: { full_name: "New Name", phone: "081-000-0000" },
  });

  const noopDiff = securityAuditLogService.diffChangedFields(
    { full_name: "Same" },
    { full_name: "Same" },
    ["full_name"]
  );

  assert.equal(noopDiff, null);
});

/* -------------------------------------- runSecurityAuditLogRetentionCleanup -------------------------------------- */

test("runSecurityAuditLogRetentionCleanup deletes rows older than the configured retention window and returns the deleted count", async () => {
  process.env.SECURITY_AUDIT_LOG_RETENTION_DAYS = "180";
  deleteOlderThanReturnCount = 42;
  const before = Date.now();

  const deletedCount = await securityAuditLogService.runSecurityAuditLogRetentionCleanup();

  const after = Date.now();

  delete process.env.SECURITY_AUDIT_LOG_RETENTION_DAYS;

  assert.equal(deletedCount, 42);
  assert.equal(deleteOlderThanCalls.length, 1);

  const cutoffMs = deleteOlderThanCalls[0].getTime();
  const retentionMs = 180 * 24 * 60 * 60 * 1000;

  // Cutoff ต้องมาจาก "ตอนนี้ - retention days" จริง ไม่ใช่ derive จากค่า record ใดๆ — เทียบแบบช่วง
  // เพราะ before/after คนละ millisecond กับตอน service คำนวณจริง
  assert.ok(cutoffMs >= before - retentionMs - 1000);
  assert.ok(cutoffMs <= after - retentionMs + 1000);
});

test("runSecurityAuditLogRetentionCleanup rejects a missing or non-positive SECURITY_AUDIT_LOG_RETENTION_DAYS", async () => {
  const original = process.env.SECURITY_AUDIT_LOG_RETENTION_DAYS;
  delete process.env.SECURITY_AUDIT_LOG_RETENTION_DAYS;

  await assert.rejects(
    () => securityAuditLogService.runSecurityAuditLogRetentionCleanup(),
    /SECURITY_AUDIT_LOG_RETENTION_DAYS/
  );

  process.env.SECURITY_AUDIT_LOG_RETENTION_DAYS = "0";

  await assert.rejects(
    () => securityAuditLogService.runSecurityAuditLogRetentionCleanup(),
    /SECURITY_AUDIT_LOG_RETENTION_DAYS/
  );

  if (original === undefined) {
    delete process.env.SECURITY_AUDIT_LOG_RETENTION_DAYS;
  } else {
    process.env.SECURITY_AUDIT_LOG_RETENTION_DAYS = original;
  }
});
