import assert from "node:assert/strict";
import { test } from "node:test";

import { assertSafeTestDatabaseUrl } from "../../setup/test-env";

/* -------------------------------------- Config -------------------------------------- */

const runDbTests = process.env.RUN_DB_TESTS === "1";

/* -------------------------------------- Tests -------------------------------------- */

// 27.14.2 — proof that the transactional wiring mobile-app-version.service.ts relies on
// (withTransaction wrapping the mutation + writeSecurityAuditLog) genuinely rolls back the
// mutation when the audit write fails, against a real Postgres transaction. The route test suite
// (test/routes/admin-settings.routes.test.ts) covers the same failure with a mocked repository,
// but that mock's in-memory store can't prove real rollback since it applies mutations
// synchronously with no transaction semantics — only a real DB can prove that.
test(
  "createMobileAppVersion's transaction pattern rolls back the mutation when the paired SecurityAuditLog write fails",
  {
    skip: runDbTests
      ? false
      : "Set RUN_DB_TESTS=1 and run PostgreSQL migration before this test.",
  },
  async () => {
    assertSafeTestDatabaseUrl();

    const { withTransaction, closePrisma } = await import("../../../src/db/prisma");
    const mobileAppVersionRepository = await import(
      "../../../src/repositories/shared/mobile-app-version.repository"
    );
    const { writeSecurityAuditLog } = await import(
      "../../../src/services/shared/security-audit-log.service"
    );
    const { SECURITY_AUDIT_OUTCOME } = await import(
      "../../../src/types/shared/security-audit-log.type"
    );
    const suffix = Date.now() % 1_000_000;
    const buildNumber = 900_000_000 + suffix;

    try {
      await assert.rejects(() =>
        withTransaction(async (transaction) => {
          await mobileAppVersionRepository.createMobileAppVersion(
            {
              version: `rollback-test-${suffix}`,
              build_number: buildNumber,
              created_by: null,
              updated_by: null,
            },
            transaction
          );

          // event_type เกิน VarChar(50) จริง ทำให้ Postgres throw จริง (ไม่ใช่ mock) — พิสูจน์ว่า
          // ถ้า audit write พังกลางทาง มี mutation ที่เพิ่งเขียนไปในธุรกรรมเดียวกันจะ rollback ด้วย
          await writeSecurityAuditLog(
            {
              // @ts-expect-error -- ตั้งใจส่งค่ายาวเกิน VarChar(50) เพื่อบังคับให้ DB reject จริง
              event_type: "x".repeat(51),
              outcome: SECURITY_AUDIT_OUTCOME.SUCCESS,
              actor_type: "admin",
            },
            transaction
          );
        })
      );

      const found = await mobileAppVersionRepository.findMobileAppVersionByBuildNumber(
        buildNumber
      );

      assert.equal(
        found,
        null,
        "the mobile app version created moments before the audit write failure must not survive the rolled-back transaction"
      );
    } finally {
      await closePrisma();
    }
  }
);

test(
  "updateMobileAppVersion's transaction pattern rolls back the mutation when the paired SecurityAuditLog write fails",
  {
    skip: runDbTests
      ? false
      : "Set RUN_DB_TESTS=1 and run PostgreSQL migration before this test.",
  },
  async () => {
    assertSafeTestDatabaseUrl();

    const { withTransaction, closePrisma } = await import("../../../src/db/prisma");
    const mobileAppVersionRepository = await import(
      "../../../src/repositories/shared/mobile-app-version.repository"
    );
    const { writeSecurityAuditLog } = await import(
      "../../../src/services/shared/security-audit-log.service"
    );
    const { SECURITY_AUDIT_OUTCOME } = await import(
      "../../../src/types/shared/security-audit-log.type"
    );
    const suffix = Date.now() % 1_000_000;
    const buildNumber = 800_000_000 + suffix;

    try {
      const seeded = await mobileAppVersionRepository.createMobileAppVersion({
        version: `rollback-seed-${suffix}`,
        build_number: buildNumber,
        release_message: "before",
        created_by: null,
        updated_by: null,
      });

      await assert.rejects(() =>
        withTransaction(async (transaction) => {
          await mobileAppVersionRepository.updateMobileAppVersion(
            seeded.id,
            { release_message: "after (should not persist)" },
            transaction
          );

          await writeSecurityAuditLog(
            {
              // @ts-expect-error -- ตั้งใจส่งค่ายาวเกิน VarChar(50) เพื่อบังคับให้ DB reject จริง
              event_type: "x".repeat(51),
              outcome: SECURITY_AUDIT_OUTCOME.SUCCESS,
              actor_type: "admin",
            },
            transaction
          );
        })
      );

      const found = await mobileAppVersionRepository.findMobileAppVersionById(seeded.id);

      assert.equal(
        found?.release_message,
        "before",
        "the update made moments before the audit write failure must not survive the rolled-back transaction"
      );
    } finally {
      await closePrisma();
    }
  }
);
