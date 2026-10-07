// Import Library
import { Prisma } from "@prisma/client";
// Import Config
import { closePrisma, prisma } from "../src/db/prisma";
// Import Types
import type { GateTicketRevisionSnapshot } from "../src/types/gate.type";
// Import Utils
import { buildGateTicketChangeDetails } from "../src/utils/gate-ticket-change-details";

/* -------------------------------------- Config -------------------------------------- */

// Config จำนวนแถวที่อ่านต่อรอบ
const BATCH_SIZE = 200;
// Config เขียนลง DB จริงเฉพาะเมื่อส่ง --apply (ค่าเริ่มต้นเป็น dry-run)
const APPLY = process.argv.includes("--apply");

/* -------------------------------------- Functions -------------------------------------- */

// Function backfill change_details ของ Gate UPDATE log เก่าที่มี snapshot ก่อน/หลัง (รันซ้ำได้ ทำเฉพาะแถวที่ยังเป็น null)
async function backfillGateChangeDetails(): Promise<void> {
  let lastId = 0;
  let scanned = 0;
  let filled = 0;

  for (;;) {
    const rows = await prisma.gateRequestLog.findMany({
      where: {
        id: { gt: lastId },
        requestType: "UPDATE",
        changeDetails: { equals: Prisma.DbNull },
        beforeSnapshot: { not: Prisma.DbNull },
        afterSnapshot: { not: Prisma.DbNull },
      },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
      select: { id: true, beforeSnapshot: true, afterSnapshot: true },
    });

    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      const details = buildGateTicketChangeDetails(
        row.beforeSnapshot as unknown as GateTicketRevisionSnapshot,
        row.afterSnapshot as unknown as GateTicketRevisionSnapshot
      );

      scanned += 1;

      if (APPLY) {
        // เงื่อนไข null กันเขียนทับแถวที่ PUT ใหม่บันทึกไว้แล้ว
        const updated = await prisma.gateRequestLog.updateMany({
          where: { id: row.id, changeDetails: { equals: Prisma.DbNull } },
          data: { changeDetails: details as unknown as Prisma.InputJsonValue },
        });

        filled += updated.count;
      }
    }

    lastId = rows[rows.length - 1].id;
  }

  console.log(
    APPLY
      ? `Backfilled change_details on ${filled} of ${scanned} Gate UPDATE log(s).`
      : `Dry run: ${scanned} Gate UPDATE log(s) would be backfilled. Re-run with --apply to write.`
  );
}

backfillGateChangeDetails()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closePrisma());
