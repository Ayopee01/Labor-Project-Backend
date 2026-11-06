// Import Library
import type { PrismaClient } from "@prisma/client";

/* -------------------------------------- Mock Data -------------------------------------- */

// Mock data สำหรับ Runtime Settings
export const SEED_RUNTIME_SETTINGS = {
  driver_session_ttl_hours: 24,
  worker_accept_deadline_seconds: 60,
  worker_accept_timeout_limit: 3,
  worker_scan_deadline_minutes: 15,
  worker_scan_warning_before_minutes: 2,
  worker_scan_team_remaining_minutes: 5,
  worker_break_duration_minutes: 15,
  worker_break_limit: 4,
  worker_break_count_ttl_hours: 48,
  worker_break_retry: 1,
  worker_presence_stale_seconds: 90,
  vendor_confirm_timeout_minutes: 60,
  vendor_reconfirm_timeout_minutes: 60,
} as const;

/* -------------------------------------- Functions -------------------------------------- */

// Function seed system_settings ให้ครบทุก RUNTIME_SETTING_KEYS
export async function seedRuntimeSettings(
  prisma: PrismaClient,
  updatedBy: number | null,
): Promise<void> {
  for (const [key, value] of Object.entries(SEED_RUNTIME_SETTINGS)) {
    await prisma.systemSetting.upsert({
      where: {
        key,
      },
      update: {
        value: String(value),
        updatedBy,
      },
      create: {
        key,
        value: String(value),
        updatedBy,
      },
    });
  }

  console.log(
    `Seeded ${Object.keys(SEED_RUNTIME_SETTINGS).length} system_settings rows.`,
  );
}
