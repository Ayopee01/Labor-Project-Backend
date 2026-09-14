// Import Repositories
import * as masterWorkerRepository from "./master-worker.repository";
// Import Types
import type { DbConnection } from "../../types/shared/common.type";
import type { WorkScheduleDto } from "../../types/admin-workers.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function ค้นหา shift assignment ปัจจุบันของ worker จาก DB (field อยู่บน MasterWorker เอง ไม่ใช่
// entity แยก — 1 worker มีได้แค่ 1 schedule ปัจจุบันเสมอ)
export async function findCurrentByAccountId(
  workerId: number | string,
  connection?: DbConnection,
): Promise<WorkScheduleDto | null> {
  return masterWorkerRepository.findCurrentScheduleByWorkerId(workerId, connection);
}

// Function ค้นหา work schedule ตาม id — schedule.id เท่ากับ worker.id เสมอ (ดู mapWorkerSchedule)
export async function findById(
  scheduleId: number,
  connection?: DbConnection,
): Promise<WorkScheduleDto | null> {
  return masterWorkerRepository.findCurrentScheduleByWorkerId(scheduleId, connection);
}
