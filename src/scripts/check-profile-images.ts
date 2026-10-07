// Import Library
import dotenv from "dotenv";
// Import Config
import { closePrisma } from "../db/prisma";
// Import Services
import { checkProfileImages, hasProfileImageProblems } from "../services/shared/profile-image-check.service";

dotenv.config({ quiet: true });

/* -------------------------------------- Functions -------------------------------------- */

// Function พิมพ์รายงานรูปโปรไฟล์ที่ครบ/ขาด (--verify = เช็คไฟล์บน Spaces จริงด้วย) คืน exit code 1 ถ้ายังมีรูปค้าง
async function main(): Promise<void> {
  try {
    const report = await checkProfileImages({ verify: process.argv.includes("--verify") });

    console.log(JSON.stringify(report, null, 2));

    if (hasProfileImageProblems(report)) {
      process.exitCode = 1;
    }
  } finally {
    await closePrisma();
  }
}

void main();
