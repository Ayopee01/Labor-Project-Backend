// Import Library
import { Prisma } from "@prisma/client";
import type { WorkerCheckinLog } from "@prisma/client";
// Import Repositories
import { client } from "./repository-utils";
// Import Types
import type { DbConnection } from "../../types/shared/common.type";
import type { WorkerCheckinLogKeyInput, WorkerCheckinLogWriteInput, WorkerShiftCloseReason } from "../../types/worker.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function สร้างข้อมูล snapshot ของกะ (รหัส worker และเวลากะ) สำหรับบันทึกลง checkin log
function buildShiftSnapshot(input: WorkerCheckinLogWriteInput) {
  return {
    workerCode: input.worker_code,
    shiftName: input.schedule.shift_name,
    timeIn: input.schedule.time_in,
    timeOut: input.schedule.time_out,
  };
}

// Function สร้าง where ตาม unique key (workerId + shiftInstanceKey)
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

// Function ค้นหา checkin log ของ worker หลายคนตาม (worker_id, shift_instance_key) ในครั้งเดียว
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

// Function เปิดกะที่ปิดไปแล้วกลับมาเมื่อ Admin force เข้าคิว (ล้างสถานะปิดและรีเซ็ต timeout streak)
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

// Function ปิดกะของ worker แบบ idempotent (เรียกซ้ำได้ผลเหมือนครั้งแรก)
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

  // ปิดเฉพาะแถวที่ยังไม่ปิด (closedAt: null) เพื่อไม่ให้เรียกซ้ำเขียนทับ
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

  // ไม่มีแถวให้ปิด: ปิดไปแล้ว (คืนค่าเดิม) หรือไม่เคย online (สร้างใหม่ โดยกันชน P2002)
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
