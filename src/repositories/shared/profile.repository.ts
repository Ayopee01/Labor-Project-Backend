// Import Repositories
import * as masterWorkerRepository from "./master-worker.repository";
// Import Types
import type { DbConnection } from "../../types/shared/common.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function โหลด WorkerCode จาก worker id เพื่อไม่ส่ง id ภายในออกไปกับ event
export async function findWorkerCodeByAccountId(
  workerId: number,
  connection?: DbConnection,
): Promise<string | null> {
  return masterWorkerRepository.findWorkerCodeByWorkerId(workerId, connection);
}

// Function สร้าง map จาก worker id เป็น WorkerCode ด้วย query เดียว
export async function findWorkerCodeMapByAccountIds(
  workerIds: number[],
  connection?: DbConnection,
): Promise<Map<number, string | null>> {
  return masterWorkerRepository.findWorkerCodeMapByWorkerIds(workerIds, connection);
}

// Function คืน WorkerCode ตามลำดับเดียวกับ worker id ที่ส่งเข้ามา
export async function findWorkerCodesByAccountIds(
  workerIds: number[],
  connection?: DbConnection,
): Promise<Array<string | null>> {
  return masterWorkerRepository.listWorkerCodesByWorkerIds(workerIds, connection);
}
