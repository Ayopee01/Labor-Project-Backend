import assert from "node:assert/strict";
import test from "node:test";
import Module = require("node:module");

import { applyIsolatedTestEnv } from "../../setup/test-env";
import { FakeRedis } from "../../helpers/app-test-infra-mocks";

/* -------------------------------------- Test Env -------------------------------------- */

applyIsolatedTestEnv("runtime-settings-sync");
process.env.WORKER_PRESENCE_STALE_SECONDS = "90";

/* -------------------------------------- Module Loader Patch -------------------------------------- */

type ModuleLoad = (
  request: string,
  parent: NodeModule | null | undefined,
  isMain: boolean,
) => unknown;

type ModuleWithLoad = typeof Module & { _load: ModuleLoad };

const moduleWithLoad = Module as ModuleWithLoad;
const originalLoad = moduleWithLoad._load;

const FULL_SETTINGS_ROW = [
  { key: "driver_session_ttl_hours", value: "24" },
  { key: "worker_accept_deadline_seconds", value: "60" },
  { key: "worker_accept_timeout_limit", value: "3" },
  { key: "worker_scan_deadline_minutes", value: "15" },
  { key: "worker_scan_warning_before_minutes", value: "2" },
  { key: "worker_scan_team_remaining_minutes", value: "5" },
  { key: "worker_break_duration_minutes", value: "15" },
  { key: "worker_break_limit", value: "4" },
  { key: "worker_break_count_ttl_hours", value: "48" },
  { key: "worker_presence_stale_seconds", value: "90" },
  { key: "vendor_confirm_timeout_hours", value: "24" },
  { key: "vendor_reconfirm_timeout_hours", value: "4" },
];

let listSettingsCallCount = 0;

// Mock Redis and settings repository while keeping other wiring real
moduleWithLoad._load = function patchedLoad(
  request: string,
  parent: NodeModule | null | undefined,
  isMain: boolean,
) {
  if (request === "ioredis") {
    return FakeRedis;
  }

  if (request === "../../repositories/shared/system-setting.repository") {
    return {
      listSettings: async () => {
        listSettingsCallCount += 1;

        return FULL_SETTINGS_ROW;
      },
    };
  }

  return originalLoad.apply(this, [request, parent, isMain]);
};

test("publishing a runtime settings invalidation makes a subscribed instance drop its cache and re-read from DB", async () => {
  const runtimeSettingsSync = await import(
    "../../../src/queues/runtime-settings-sync"
  );
  const runtimeSettingsService = await import(
    "../../../src/services/shared/runtime-settings.service"
  );

  runtimeSettingsSync.startRuntimeSettingsSync();
  // subscribe เป็น async ฝั่ง FakeRedis (resolve ทันที) แต่รอ 1 tick กันพลาด microtask ordering
  await new Promise((resolve) => setImmediate(resolve));

  await runtimeSettingsService.getRuntimeSettings();
  const callsAfterFirstRead = listSettingsCallCount;

  // อ่านซ้ำทันทีต้องมาจาก cache ไม่ยิง DB ซ้ำ (พิสูจน์ cache ทำงานปกติก่อน)
  await runtimeSettingsService.getRuntimeSettings();
  assert.equal(
    listSettingsCallCount,
    callsAfterFirstRead,
    "second read within TTL should be served from cache, not re-query the DB",
  );

  // จำลอง instance อื่น (หรือ request PATCH settings ที่ตกไปยัง instance อื่น) publish
  // แจ้ง invalidate ผ่าน Redis channel เดียวกัน
  await runtimeSettingsSync.publishRuntimeSettingsInvalidation();

  await runtimeSettingsService.getRuntimeSettings();
  assert.equal(
    listSettingsCallCount,
    callsAfterFirstRead + 1,
    "read after receiving the pub/sub invalidation must re-query the DB instead of serving stale cache",
  );

  await runtimeSettingsSync.closeRuntimeSettingsSyncConnections();
});
