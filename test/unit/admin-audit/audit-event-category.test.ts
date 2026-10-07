// Import Library
import assert from "node:assert/strict";
import { test } from "node:test";
// Import Types
import { ADMIN_AUDIT_EVENT_CATEGORY_BY_TYPE, ADMIN_AUDIT_EVENT_CATEGORY_VALUES } from "../../../src/types/admin-audit.type";
import { SECURITY_AUDIT_EVENT_TYPE } from "../../../src/types/shared/security-audit-log.type";

/* -------------------------------------- Tests -------------------------------------- */

test("every SecurityAuditLog event_type has a category in the central audit mapping", () => {
  for (const eventType of Object.values(SECURITY_AUDIT_EVENT_TYPE)) {
    assert.ok(
      Object.hasOwn(ADMIN_AUDIT_EVENT_CATEGORY_BY_TYPE, eventType),
      `${eventType} is missing from ADMIN_AUDIT_EVENT_CATEGORY_BY_TYPE`
    );
  }
});

test("central audit mapping only uses known categories and matches the contract size per category", () => {
  const countByCategory: Record<string, number> = {};

  for (const category of Object.values(ADMIN_AUDIT_EVENT_CATEGORY_BY_TYPE)) {
    assert.ok((ADMIN_AUDIT_EVENT_CATEGORY_VALUES as readonly string[]).includes(category));
    countByCategory[category] = (countByCategory[category] ?? 0) + 1;
  }

  assert.deepEqual(countByCategory, {
    operations: 27,
    security: 7,
    user_management: 7,
    system_integration: 8,
  });
});
