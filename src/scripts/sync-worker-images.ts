// Import Library
import dotenv from "dotenv";
// Import Config
import { closePrisma } from "../db/prisma";
// Import Services
import { syncAllWorkerImages, syncPendingWorkerImages } from "../services/shared/worker-image.service";

dotenv.config({ quiet: true });

/* -------------------------------------- Functions -------------------------------------- */

// Function อัปโหลดรูป Worker ขึ้น Spaces แล้วพิมพ์สรุปผล (--all = ตรวจทุกคนแบบเทียบ hash แทนเฉพาะที่ค้าง)
async function main(): Promise<void> {
  try {
    const summary = process.argv.includes("--all")
      ? await syncAllWorkerImages()
      : await syncPendingWorkerImages();

    console.log(`[images:sync] ${JSON.stringify(summary, null, 2)}`);

    if (!summary.spaces_configured) {
      console.log("[images:sync] Spaces is not configured (SPACES_* in .env); nothing was uploaded.");
    }

    if (summary.failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await closePrisma();
  }
}

void main();
