import dotenv from "dotenv";
import { closePrisma, getPrisma } from "../src/db/prisma";
import { seedRuntimeSettings } from "./runtime-settings.seed";

dotenv.config({ quiet: true });

const prisma = getPrisma();

// Script bootstrap เฉพาะ system_settings ให้ครบทุก RUNTIME_SETTING_KEYS สำหรับฐานข้อมูล test เท่านั้น
// (concurrency/e2e/realtime tests ต่อ service layer จริง ซึ่งเรียก getRuntimeSettings() แล้วจะพังด้วย
// SYSTEM_SETTINGS_NOT_CONFIGURED ถ้าไม่มีแถวพวกนี้) ไม่ใช้ seed.ts เต็มรูปแบบเพราะไฟล์นั้นอัปโหลดรูป
// master worker จริงไปที่ Spaces ด้วย ซึ่งไม่มี credential ให้ใช้ใน CI/test environment
async function main(): Promise<void> {
  await seedRuntimeSettings(prisma, null);
  console.log("Test system settings seed completed.");
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await closePrisma();
  });
