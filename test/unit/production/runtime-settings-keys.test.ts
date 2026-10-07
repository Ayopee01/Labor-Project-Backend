// Import Library
import assert from "node:assert/strict";
import test from "node:test";
// Import Config
import { RUNTIME_SETTING_KEYS } from "../../../src/config/runtime.config";
// Import Validation
import { runtimeSettingsSchema, updateSystemSettingsBodySchema } from "../../../src/validation/schemas";

// key ของ runtime settings ทั้ง 3 จุดต้องตรงกันเสมอ

test("RUNTIME_SETTING_KEYS, runtimeSettingsSchema, and updateSystemSettingsBodySchema stay in sync", () => {
  const expectedKeys = [...RUNTIME_SETTING_KEYS].sort();
  const runtimeSchemaKeys = Object.keys(runtimeSettingsSchema.shape).sort();
  const updateSchemaKeys = Object.keys(updateSystemSettingsBodySchema.shape).sort();

  assert.deepEqual(
    runtimeSchemaKeys,
    expectedKeys,
    "runtimeSettingsSchema must declare exactly the keys in RUNTIME_SETTING_KEYS",
  );
  assert.deepEqual(
    updateSchemaKeys,
    expectedKeys,
    "updateSystemSettingsBodySchema must declare exactly the keys in RUNTIME_SETTING_KEYS",
  );
});
