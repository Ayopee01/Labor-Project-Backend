import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { test } from "node:test";

import { assertSafeTestDatabaseUrl } from "../../setup/test-env";

/* -------------------------------------- Config -------------------------------------- */

const runDbTests = process.env.RUN_DB_TESTS === "1";

/* -------------------------------------- Tests -------------------------------------- */

test(
  "services create user, login, refresh, and read current schedule",
  {
    skip: runDbTests
      ? false
      : "Set RUN_DB_TESTS=1 and run PostgreSQL migration before this test.",
  },
  async () => {
    assertSafeTestDatabaseUrl();

    // ต้องยาวอย่างน้อย 32 ตัวอักษรเพื่อผ่านเกณฑ์ความแข็งแรงของ Secret ที่ jwt.ts/refresh-token-hash.ts เช็ค
    process.env.JWT_ACCESS_SECRET = "service-test-access-secret-min-32";
    process.env.JWT_REFRESH_SECRET = "service-test-refresh-secret-min-32";
    process.env.JWT_LOGIN_CHALLENGE_SECRET =
      "service-test-login-challenge-secret-min-32";
    process.env.REFRESH_TOKEN_HASH_SECRET = "service-test-refresh-hash-secret-min-32";

    const authService = await import("../../../src/services/auth.service");
    const { findByIdentifier } = await import(
      "../../../src/repositories/admin-workers.repository"
    );
    const userService = await import("../../../src/services/admin-workers.service");
    const { closePrisma } = await import("../../../src/db/prisma");
    const { closeWorkerQueueConnections } = await import(
      "../../../src/queues/worker-queue"
    );
    const { hashPassword, verifyPassword } = await import("../../../src/utils/password");
    const suffix = Date.now().toString(36);
    // phone ต้องเป็นตัวเลขล้วนเท่านั้น (ห้ามมีตัวอักษรปน) เพราะ test นี้ใช้ phone ตัวเดียวกันทั้งเป็น
    // input ตอนสร้าง worker และเป็น password ตอน login ตรงๆ (createUser hash จาก
    // normalizePhoneDigits(phone) เสมอ — ถ้า phone มีตัวอักษรปน normalizePhoneDigits จะได้ค่าที่ไม่
    // เท่ากับ phone เดิม ทำให้ verifyPassword/login ด้านล่างไม่ผ่าน และถ้า phone ไม่มีตัวเลขเลยแม้แต่
    // ตัวเดียว hashPassword จะ throw เพราะได้ empty string หลัง normalize)
    const phone = `${Date.now()}${String(randomInt(0, 1000)).padStart(3, "0")}`;
    const shirtNumber = String(randomInt(0, 1_000_000));
    const workerCode = `MN${shirtNumber.padStart(6, "0")}`;

    try {
      const created = await userService.createUser(
        {
          img: "https://example.com/worker.jpg",
          full_name: "Service Worker",
          phone,
          nationality: "Myanmar",
          shirt_type: "Navy",
          shirt_number: shirtNumber,
          work_start_date: "2024-07-15",
          status: "active",
          time_work: "Morning",
        },
        {
          account_id: 1,
          role: "admin",
          session_id: 1,
          token_type: "access",
        }
      );

      assert.equal(created.message, "Worker created successfully.");
      const worker = await findByIdentifier(workerCode);
      assert.ok(worker);
      assert.equal(worker.telephone, phone);
      assert.equal(await verifyPassword(phone, worker.password_hash ?? ""), true);

      const { createAdmin } = await import(
        "../../../src/repositories/admin-settings.repository"
      );
      const admin = await createAdmin({
        username: `service-admin-${suffix}`,
        password_hash: await hashPassword("Admin@123456"),
        role: "admin",
        status: "active",
        full_name: "Service Admin",
        position: "Administrator",
        permission_level: "manager",
        created_by: 1,
      });

      const adminLogin = await authService.login({
        username: admin.username,
        password: "Admin@123456",
      });

      assert.equal(adminLogin.token_type, "Bearer");
      assert.ok(adminLogin.access_token);
      assert.ok(adminLogin.refresh_token);
      assert.equal((adminLogin as { account?: unknown }).account, undefined);
      assert.equal((adminLogin as { profile?: unknown }).profile, undefined);
      assert.equal(
        (adminLogin as { current_work_schedule?: unknown }).current_work_schedule,
        undefined
      );
      assert.equal(
        (adminLogin as { profile_card?: unknown }).profile_card,
        undefined
      );

      await assert.rejects(
        () =>
          authService.login({
            username: workerCode,
            password: phone,
          }),
        (error) =>
          Boolean(
            error &&
            typeof error === "object" &&
            (error as { code?: string }).code === "VALIDATION_ERROR"
          )
      );

      const login = await authService.login({
        username: workerCode,
        password: phone,
        device_id: `browser-device-${suffix}`,
        device_name: "Chrome on Windows",
      });

      assert.equal(login.token_type, "Bearer");
      assert.ok(login.access_token);
      assert.ok(login.refresh_token);
      assert.equal((login as { account?: unknown }).account, undefined);

      const refreshed = await authService.refresh({
        refresh_token: login.refresh_token,
      });

      assert.ok(refreshed.access_token);
      assert.ok(refreshed.refresh_token);

      const list = await userService.listUsers({
        page: 1,
        limit: 20,
        search: workerCode,
      });

      assert.equal(list.pagination.total, 1);

      const byWorkerCode = await userService.listUsers({
        page: 1,
        limit: 20,
        worker_code: workerCode.slice(0, 4).toLowerCase(),
      });

      assert.equal(byWorkerCode.pagination.total, 1);
      assert.equal(byWorkerCode.data[0].worker_code, workerCode);

      const byFullName = await userService.listUsers({
        page: 1,
        limit: 20,
        full_name: "service worker",
      });

      assert.ok(byFullName.data.some((item) => item.worker_code === workerCode));

      const byShirtNumber = await userService.listUsers({
        page: 1,
        limit: 20,
        shirt_number: shirtNumber,
      });

      assert.equal(byShirtNumber.pagination.total, 1);
      assert.equal(byShirtNumber.data[0].worker_code, workerCode);

      const byShiftMatch = await userService.listUsers({
        page: 1,
        limit: 20,
        worker_code: workerCode,
        shift: "MORNING",
      });

      assert.equal(byShiftMatch.pagination.total, 1);

      const byShiftMismatch = await userService.listUsers({
        page: 1,
        limit: 20,
        worker_code: workerCode,
        shift: "EVENING",
      });

      assert.equal(byShiftMismatch.pagination.total, 0);

      const createdUser = list.data[0];
      assert.equal(createdUser.worker_code, workerCode);
      assert.equal((createdUser as { id?: number }).id, undefined);
      assert.equal(
        (createdUser as { password_hash?: string }).password_hash,
        undefined
      );
      assert.equal(
        (createdUser as { username?: string }).username,
        undefined
      );
      assert.equal(createdUser.labor_color, "Navy");
      assert.equal(createdUser.full_name, "Service Worker");
      assert.equal(createdUser.status, "active");
      assert.equal(createdUser.work_start_date, "2024-07-15");
      assert.equal((createdUser as { work_schedules?: unknown }).work_schedules, undefined);
      assert.equal(createdUser.work_schedule?.time_work, "Morning");
      assert.equal(createdUser.work_schedule?.time_in, "08:00");
      assert.equal(createdUser.work_schedule?.time_out, "18:00");
      assert.ok(createdUser.work_schedule?.shift_name);
      assert.equal(
        (createdUser.work_schedule as { id?: number } | null)?.id,
        undefined
      );
      assert.equal(
        (createdUser.work_schedule as { worker_id?: number } | null)?.worker_id,
        undefined
      );
      assert.equal(
        (createdUser.work_schedule as { created_by?: number } | null)?.created_by,
        undefined
      );
      assert.equal(
        (createdUser.work_schedule as { updated_by?: number } | null)?.updated_by,
        undefined
      );
      assert.equal(
        (createdUser.work_schedule as { created_at?: string } | null)?.created_at,
        undefined
      );
      assert.equal(
        (createdUser.work_schedule as { updated_at?: string } | null)?.updated_at,
        undefined
      );
      assert.equal(
        (createdUser.work_schedule as { is_current?: boolean } | null)?.is_current,
        undefined
      );
      const updated = await userService.updateUser(
        workerCode,
        {
          status: "inactive",
          time_in: "18:00",
          time_out: "06:00",
        },
        {
          account_id: 1,
          role: "admin",
          session_id: 1,
          token_type: "access",
        }
      );

      assert.equal(updated.status, "inactive");
      assert.equal(updated.worker_code, workerCode);
      assert.equal(updated.details.work_start_date, "2024-07-15");
      assert.equal((updated.details as { work_schedules?: unknown }).work_schedules, undefined);
      assert.equal(updated.details.time_work, "Evening");
      assert.equal(updated.details.time_in, "18:00");
      assert.equal(updated.details.time_out, "06:00");
      assert.ok(updated.details.shift_name);
    } finally {
      await closePrisma();
      await closeWorkerQueueConnections();
    }
  }
);
