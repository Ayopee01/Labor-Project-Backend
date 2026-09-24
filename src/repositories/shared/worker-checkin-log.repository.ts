// Import Library
import { Prisma } from "@prisma/client";
// Import Utils
import { client } from "./repository-utils";
// Import Types
import type { WorkerCheckinLog } from "@prisma/client";
import type { DbConnection } from "../../types/shared/common.type";
import type { WorkerCheckinLogKeyInput, WorkerCheckinLogWriteInput, WorkerShiftCloseReason } from "../../types/worker.type";

/* -------------------------------------- Functions -------------------------------------- */

function buildShiftSnapshot(input: WorkerCheckinLogWriteInput) {
  return {
    workerCode: input.worker_code,
    timeWork: input.schedule.time_work,
    timeIn: input.schedule.time_in,
    timeOut: input.schedule.time_out,
  };
}

// Function สร้าง where clause ตาม unique key (workerId + shiftInstanceKey) — ใช้ร่วมกันทุกฟังก์ชันใน
// ไฟล์นี้ที่ query/upsert แถว checkin log ของกะเดียวกัน
function buildCheckinLogKeyWhere(input: WorkerCheckinLogKeyInput) {
  return {
    workerId_shiftInstanceKey: {
      workerId: input.worker_id,
      shiftInstanceKey: input.shift_instance_key,
    },
  };
}

// Function ค้นหา checkin log ของ worker ตาม shift instance key จาก DB
export async function findByWorkerAndShift(
  input: WorkerCheckinLogKeyInput,
  connection?: DbConnection
): Promise<WorkerCheckinLog | null> {
  const db = client(connection);

  return db.workerCheckinLog.findUnique({
    where: buildCheckinLogKeyWhere(input),
  });
}

// Function ค้นหา checkin log ของ worker หลายคนพร้อมกัน ตาม (worker_id, shift_instance_key) คู่ของแต่ละคน —
// ใช้ตอน Admin ดู worker status แบบ list เพื่อคำนวณ reason ของ shift_active โดยไม่ query ทีละคน
export async function findManyByWorkerAndShiftKeys(
  keys: WorkerCheckinLogKeyInput[],
  connection?: DbConnection
): Promise<Map<number, WorkerCheckinLog>> {
  if (keys.length === 0) {
    return new Map();
  }

  const db = client(connection);
  const logs = await db.workerCheckinLog.findMany({
    where: {
      OR: keys.map((key) => ({
        workerId: key.worker_id,
        shiftInstanceKey: key.shift_instance_key,
      })),
    },
  });

  return new Map(logs.map((log) => [log.workerId, log]));
}

// Function ทำเครื่องหมายว่า worker online ในกะนี้ (สร้างใหม่ถ้ายังไม่มี หรืออัปเดตถ้ามีอยู่แล้ว)
export async function markWorkerShiftOnline(
  input: WorkerCheckinLogWriteInput,
  connection?: DbConnection
): Promise<WorkerCheckinLog> {
  const db = client(connection);
  const now = new Date();
  const shiftSnapshot = buildShiftSnapshot(input);

  return db.workerCheckinLog.upsert({
    where: buildCheckinLogKeyWhere(input),
    create: {
      workerId: input.worker_id,
      shiftInstanceKey: input.shift_instance_key,
      ...shiftSnapshot,
      firstOnlineAt: now,
      lastOnlineAt: now,
    },
    update: {
      ...shiftSnapshot,
      lastOnlineAt: now,
    },
  });
}

// Function เพิ่มจำนวนครั้งที่ worker ปล่อย accept timeout ติดกันในกะนี้
export async function incrementAcceptTimeoutStreak(
  input: WorkerCheckinLogWriteInput,
  connection?: DbConnection
): Promise<WorkerCheckinLog> {
  const db = client(connection);
  const now = new Date();
  const shiftSnapshot = buildShiftSnapshot(input);

  return db.workerCheckinLog.upsert({
    where: buildCheckinLogKeyWhere(input),
    create: {
      workerId: input.worker_id,
      shiftInstanceKey: input.shift_instance_key,
      ...shiftSnapshot,
      firstOnlineAt: now,
      lastOnlineAt: now,
      acceptTimeoutStreak: 1,
      lastAcceptTimeoutAt: now,
    },
    update: {
      ...shiftSnapshot,
      acceptTimeoutStreak: {
        increment: 1,
      },
      lastAcceptTimeoutAt: now,
    },
  });
}

// Function รีเซ็ตจำนวนครั้ง accept timeout ที่ติดกันของ worker ในกะนี้
export async function resetAcceptTimeoutStreak(
  input: WorkerCheckinLogWriteInput,
  connection?: DbConnection
): Promise<WorkerCheckinLog> {
  const db = client(connection);
  const now = new Date();
  const shiftSnapshot = buildShiftSnapshot(input);

  return db.workerCheckinLog.upsert({
    where: buildCheckinLogKeyWhere(input),
    create: {
      workerId: input.worker_id,
      shiftInstanceKey: input.shift_instance_key,
      ...shiftSnapshot,
      firstOnlineAt: now,
      lastOnlineAt: now,
      acceptTimeoutStreak: 0,
      lastAcceptTimeoutAt: null,
    },
    update: {
      ...shiftSnapshot,
      acceptTimeoutStreak: 0,
      lastAcceptTimeoutAt: null,
    },
  });
}

// Function เปิดกะที่ถูกปิดไปแล้วกลับมา (Admin force Worker กลับเข้าคิวเป็น READY/BREAK) — ล้าง closedAt/closeReason/
// offlineAt ให้เส้นทาง requeue อัตโนมัติ (isWorkerShiftOpenForQueue) ถือว่ากะเปิดอยู่อีกครั้ง และรีเซ็ต
// acceptTimeoutStreak กัน timeout ครั้งแรกหลัง Admin ดึงกลับปิดกะซ้ำทันทีเพราะ streak เดิมเต็ม limit อยู่แล้ว
export async function reopenWorkerShift(
  input: WorkerCheckinLogWriteInput,
  connection?: DbConnection
): Promise<WorkerCheckinLog> {
  const db = client(connection);
  const now = new Date();
  const shiftSnapshot = buildShiftSnapshot(input);

  return db.workerCheckinLog.upsert({
    where: buildCheckinLogKeyWhere(input),
    create: {
      workerId: input.worker_id,
      shiftInstanceKey: input.shift_instance_key,
      ...shiftSnapshot,
      firstOnlineAt: now,
      lastOnlineAt: now,
    },
    update: {
      ...shiftSnapshot,
      lastOnlineAt: now,
      closedAt: null,
      closeReason: null,
      offlineAt: null,
      acceptTimeoutStreak: 0,
      lastAcceptTimeoutAt: null,
    },
  });
}

// Function ปิดกะของ worker แบบ idempotent รองรับ Double-submit/Retry โดยไม่ให้ผลลัพธ์เพี้ยนไปจากครั้งแรกที่ปิดจริง
export async function closeWorkerShift(
  input: WorkerCheckinLogWriteInput & {
    reason: WorkerShiftCloseReason;
  },
  connection?: DbConnection
): Promise<WorkerCheckinLog> {
  const db = client(connection);
  const now = new Date();
  const shiftSnapshot = buildShiftSnapshot(input);
  const closeData: Prisma.WorkerCheckinLogUncheckedUpdateInput = {
    ...shiftSnapshot,
    closedAt: now,
    closeReason: input.reason,
    offlineAt: now,
  };

  // ปิดแบบมีเงื่อนไข (closedAt: null) กัน Double-submit เขียนทับกัน — เรียกซ้ำต้องได้ค่าของครั้งแรก
  // ที่ปิดจริงเสมอ ไม่ใช่ค่าจาก Reason ล่าสุด
  // หมายเหตุ: updateMany ไม่รองรับ compound-unique shorthand (buildCheckinLogKeyWhere) ต้องระบุ field ตรงๆ
  const closedNow = await db.workerCheckinLog.updateMany({
    where: {
      workerId: input.worker_id,
      shiftInstanceKey: input.shift_instance_key,
      closedAt: null,
    },
    data: closeData,
  });

  if (closedNow.count === 1) {
    const updated = await findByWorkerAndShift(input, connection);

    if (!updated) {
      throw new Error("Worker checkin log disappeared right after being closed.");
    }

    return updated;
  }

  // ไม่เจอแถวให้ปิด: อาจปิดไปแล้ว (คืนค่าเดิม) หรือยังไม่เคย Online เลย — กรณีหลัง create ใหม่ แต่ต้อง
  // กัน P2002 จาก Double-submit ที่แข่งกัน create แถวเดียวกัน (Unique workerId+shiftInstanceKey)
  const existing = await findByWorkerAndShift(input, connection);

  if (existing) {
    return existing;
  }

  try {
    return await db.workerCheckinLog.create({
      data: {
        workerId: input.worker_id,
        shiftInstanceKey: input.shift_instance_key,
        ...shiftSnapshot,
        closedAt: now,
        closeReason: input.reason,
        offlineAt: now,
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const concurrentlyCreated = await findByWorkerAndShift(input, connection);

      if (concurrentlyCreated) {
        return concurrentlyCreated;
      }
    }

    throw error;
  }
}
