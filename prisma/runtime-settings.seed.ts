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
  worker_presence_stale_seconds: 90,
  vendor_confirm_timeout_hours: 24,
  vendor_reconfirm_timeout_hours: 4,
} as const;

/* -------------------------------------- Functions -------------------------------------- */

// Function seed system_settings ให้ครบทุก RUNTIME_SETTING_KEYS — แยกออกมาจาก seed.ts เพื่อให้
// สคริปต์อื่น (เช่น seed-test-settings.ts ที่ใช้ bootstrap database สำหรับ concurrency/e2e/realtime
// test) เรียกใช้ได้โดยไม่ต้อง import seed.ts ทั้งไฟล์ ซึ่งจะรัน main() เต็มรูปแบบ (สร้าง master
// worker พร้อมอัปโหลดรูปจริงไปที่ Spaces) ไปด้วยโดยไม่ตั้งใจ
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
