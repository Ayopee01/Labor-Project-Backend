// Import Library
import dotenv from "dotenv";
// Import Config
import { closePrisma, getPrisma } from "../db/prisma";
// Import Repositories
import * as masterWorkerRepository from "../repositories/shared/master-worker.repository";
// Import Utils
import { hashPassword, normalizePhoneDigits, passwordNeedsRehash } from "../utils/password";

dotenv.config({ quiet: true });

/* -------------------------------------- Functions -------------------------------------- */

// Function re-hash password ของ worker ที่ยังเป็น argon2 param เก่า (หนัก) ให้เป็นค่าปัจจุบัน (เบา)
// โดยใช้เบอร์โทรใน DB เป็นรหัส — dry-run เป็นค่าเริ่มต้น ต้องส่ง --apply ถึงจะเขียนจริง
async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const prisma = getPrisma();

  // อ่านเฉพาะ field ที่ต้องใช้ (ไม่ดึง picture ที่ใหญ่)
  const workers = await prisma.masterWorker.findMany({
    select: { id: true, laborCode: true, telephone: true, passwordHash: true },
  });

  let needRehash = 0;
  let noPhone = 0;
  let updated = 0;
  let failed = 0;

  const targets = workers.filter((w) => {
    if (!passwordNeedsRehash(w.passwordHash)) {
      return false;
    }
    needRehash += 1;
    if (!w.telephone) {
      noPhone += 1;
      return false;
    }
    return true;
  });

  console.log(`total workers        : ${workers.length}`);
  console.log(`need rehash (old arg): ${needRehash}`);
  console.log(`  - skipped no phone : ${noPhone}`);
  console.log(`  - will rehash      : ${targets.length}`);
  console.log(`mode                 : ${apply ? "APPLY (writing)" : "DRY-RUN (no writes) — add --apply to write"}`);

  if (!apply) {
    await closePrisma();
    return;
  }

  // เขียนทีละชุดเล็กๆ กันยิง hash/DB พร้อมกันมากเกินไป
  const BATCH = 8;
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (w) => {
        try {
          const newHash = await hashPassword(normalizePhoneDigits(w.telephone as string));
          await masterWorkerRepository.updatePasswordHash(w.id, newHash);
          updated += 1;
        } catch (error) {
          failed += 1;
          console.error(`rehash failed for ${w.laborCode}:`, error instanceof Error ? error.message : error);
        }
      })
    );
    console.log(`  ...progress ${Math.min(i + BATCH, targets.length)}/${targets.length}`);
  }

  console.log(`updated              : ${updated}`);
  console.log(`failed               : ${failed}`);
  await closePrisma();
}

void main().catch((error) => {
  console.error("rehash-worker-passwords failed:", error);
  process.exitCode = 1;
});
