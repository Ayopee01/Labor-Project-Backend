// Import Config
import { RUNTIME_SETTING_KEYS } from "../../config/runtime.config";
import type { RuntimeSettingKey, RuntimeSettings } from "../../config/runtime.config";
// Import Repositories
import { listSettings } from "../../repositories/shared/system-setting.repository";
// Import Validation
import { runtimeSettingsSchema } from "../../validation/schemas";
import { parseWithSchema } from "../../validation/parser";
// Import Utils
import ApiError from "../../utils/api-error";

/* -------------------------------------- Config -------------------------------------- */

// Config อายุ cache ของ runtime settings
const SETTINGS_CACHE_TTL_MS = 30 * 1000;

// Config cache ของ runtime settings ในหน่วยความจำ
let cachedSettings: {
  expiresAt: number;
  value: RuntimeSettings;
  updatedAtMs: Partial<Record<RuntimeSettingKey, number>>;
} | null = null;

/* -------------------------------------- Functions -------------------------------------- */

// Function รวม settings แบบ key/value จาก DB เป็น RuntimeSettings และเช็คว่าครบทุก key
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

// Function โหลด Runtime Settings พร้อมเวลาแก้ไขล่าสุดของแต่ละ key เข้า cache (TTL 30 วินาที)
async function loadRuntimeSettingsCache(): Promise<NonNullable<typeof cachedSettings>> {
  if (cachedSettings && cachedSettings.expiresAt > Date.now()) {
    return cachedSettings;
  }

  const storedSettings = await listSettings();
  const updatedAtMs: Partial<Record<RuntimeSettingKey, number>> = {};

  for (const setting of storedSettings) {
    const parsedUpdatedAt = setting.updated_at ? Date.parse(setting.updated_at) : NaN;

    if (RUNTIME_SETTING_KEYS.includes(setting.key as RuntimeSettingKey) && Number.isFinite(parsedUpdatedAt)) {
      updatedAtMs[setting.key as RuntimeSettingKey] = parsedUpdatedAt;
    }
  }

  cachedSettings = {
    expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS,
    value: mergeRuntimeSettings(storedSettings),
    updatedAtMs,
  };

  return cachedSettings;
}

// Function ดึง Runtime Settings พร้อม cache ในหน่วยความจำ (TTL 30 วินาที) กัน query DB ถี่เกินไป
export async function getRuntimeSettings(): Promise<RuntimeSettings> {
  return (await loadRuntimeSettingsCache()).value;
}

// Function ดึงเวลาแก้ไขล่าสุดของ setting หนึ่ง key (ms) ไม่มีข้อมูลคืน 0
export async function getRuntimeSettingUpdatedAtMs(key: RuntimeSettingKey): Promise<number> {
  return (await loadRuntimeSettingsCache()).updatedAtMs[key] ?? 0;
}
