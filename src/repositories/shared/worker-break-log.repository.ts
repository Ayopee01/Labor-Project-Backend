// Import Utils
import { client } from "./repository-utils";
// Import Types
import type { WorkerBreakLog } from "@prisma/client";
import type { DbConnection } from "../../types/shared/common.type";
import type { WorkerBreakLogCloseInput, WorkerBreakLogStartInput } from "../../types/worker.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function สร้าง where clause หา checkin log ตาม unique key (workerId + shiftInstanceKey)
function buildCheckinLogKeyWhere(workerId: number, shiftInstanceKey: string) {
  return {
    workerId_shiftInstanceKey: {
      workerId,
      shiftInstanceKey,
    },
  };
}

// Function เริ่มบันทึก break log หนึ่งครั้งของกะนี้ — ต้องมี checkin log ของกะนี้อยู่แล้วเสมอ
// (worker ต้อง online ก่อนถึงจะพักได้) ถ้าไม่เจอถือเป็น bug ของ flow ที่เรียกมา ไม่ silent fail
export async function createBreakLog(
  input: WorkerBreakLogStartInput,
  connection?: DbConnection
): Promise<WorkerBreakLog> {
  const db = client(connection);
  const checkinLog = await db.workerCheckinLog.findUnique({
    where: buildCheckinLogKeyWhere(input.worker_id, input.shift_instance_key),
  });

  if (!checkinLog) {
    throw new Error("Worker checkin log not found when starting a break log.");
  }

  return db.workerBreakLog.create({
    data: {
      workerCheckinLogId: checkinLog.id,
      scheduledEndAt: input.scheduled_end_at,
    },
  });
}

// Function ปิด break log ที่ยังเปิดอยู่ล่าสุดของกะนี้ — คืน null ถ้าไม่มี checkin log หรือไม่มี break log
// ที่ยังเปิดอยู่ (เรียกซ้ำ/ไม่เคยพักเลย) เป็น idempotent เหมือน closeWorkerShift ฝั่ง checkin log
export async function closeOpenBreakLog(
  input: WorkerBreakLogCloseInput,
  connection?: DbConnection
): Promise<WorkerBreakLog | null> {
  const db = client(connection);
  const checkinLog = await db.workerCheckinLog.findUnique({
    where: buildCheckinLogKeyWhere(input.worker_id, input.shift_instance_key),
  });

  if (!checkinLog) {
    return null;
  }

  const openBreakLog = await db.workerBreakLog.findFirst({
    where: {
      workerCheckinLogId: checkinLog.id,
      endedAt: null,
    },
    orderBy: {
      id: "desc",
    },
  });

  if (!openBreakLog) {
    return null;
  }

  return db.workerBreakLog.update({
    where: {
      id: openBreakLog.id,
    },
    data: {
      endedAt: new Date(),
      endReason: input.end_reason,
    },
  });
}
