// Import Library
import dotenv from "dotenv";
// Import Config
import { closePrisma, getPrisma } from "../src/db/prisma";
// Import Seeds
import { seedRuntimeSettings } from "./runtime-settings.seed";

dotenv.config({ quiet: true });

const prisma = getPrisma();

// Function seed เฉพาะ system_settings สำหรับ DB ของ test (ไม่อัปโหลดรูปขึ้น Spaces)
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
