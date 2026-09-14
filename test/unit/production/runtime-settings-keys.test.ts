import assert from "node:assert/strict";
import test from "node:test";

import { RUNTIME_SETTING_KEYS } from "../../../src/config/runtime.config";
import { runtimeSettingsSchema, updateSystemSettingsBodySchema } from "../../../src/validation/schemas";

// RUNTIME_SETTING_KEYS, runtimeSettingsSchema, and updateSystemSettingsBodySchema each hand-list the
// same 12 setting keys independently (see src/config/runtime.config.ts and src/validation/schemas.ts).
// Nothing else enforces they stay in sync — a key added to one and forgotten in another fails only at
// runtime (SYSTEM_SETTINGS_NOT_CONFIGURED) or silently makes a setting non-editable via the admin API.
// This test turns that drift into an immediate, loud test failure instead.

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
