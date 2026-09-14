// Import Config
import { RUNTIME_SETTING_KEYS } from "../../config/runtime.config";
// Import Repositories
import { listSettings } from "../../repositories/shared/system-setting.repository";
// Import Validation
import { runtimeSettingsSchema } from "../../validation/schemas";
import { parseWithSchema } from "../../validation/parser";
// Import Utils
import ApiError from "../../utils/api-error";
// Import Config
import type { RuntimeSettingKey, RuntimeSettings } from "../../config/runtime.config";

const SETTINGS_CACHE_TTL_MS = 30 * 1000;

let cachedSettings: {
  expiresAt: number;
  value: RuntimeSettings;
} | null = null;

// Function รวม settings แบบ key/value จาก DB ให้เป็น RuntimeSettings ที่ type ตรง พร้อมเช็คว่าครบทุก key ที่ต้องมี
function mergeRuntimeSettings(
  storedSettings: { key: string; value: string }[],
): RuntimeSettings {
  const rawSettings: Partial<Record<RuntimeSettingKey, unknown>> = {};

  for (const setting of storedSettings) {
    if (RUNTIME_SETTING_KEYS.includes(setting.key as RuntimeSettingKey)) {
      rawSettings[setting.key as RuntimeSettingKey] = setting.value;
    }
  }

  const missingKeys = RUNTIME_SETTING_KEYS.filter(
    (key) => rawSettings[key] === undefined,
  );

  if (missingKeys.length > 0) {
    throw new ApiError(
      500,
      "SYSTEM_SETTINGS_NOT_CONFIGURED",
      "System settings are not fully configured.",
      {
        missing_settings: missingKeys,
      },
    );
  }

  return parseWithSchema(runtimeSettingsSchema, rawSettings);
}

// Function ล้าง cache ของ runtime settings ที่เก็บไว้ในหน่วยความจำ
export function clearRuntimeSettingsCache(): void {
  cachedSettings = null;
}

// Function ดึง Runtime Settings พร้อม cache ในหน่วยความจำ (TTL 30 วินาที) กัน query DB ถี่เกินไป
export async function getRuntimeSettings(): Promise<RuntimeSettings> {
  if (cachedSettings && cachedSettings.expiresAt > Date.now()) {
    return cachedSettings.value;
  }

  const settings = mergeRuntimeSettings(await listSettings());

  cachedSettings = {
    expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS,
    value: settings,
  };

  return settings;
}
