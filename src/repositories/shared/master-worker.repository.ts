// Import Mappers
import { mapMasterWorker, mapWorkerSchedule } from "./mappers";
import { client, requireMapped, toId } from "./repository-utils";
// Import Types
import type { DbConnection } from "../../types/shared/common.type";
import { MASTER_WORKER_STATUS } from "../../types/admin-workers.type";
import type { MasterWorkerDto, WorkScheduleDto } from "../../types/admin-workers.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function ตรวจว่า master worker ที่ map แล้วไม่เป็น null (ใช้เป็น type guard)
function isMasterWorkerDto(worker: MasterWorkerDto | null): worker is MasterWorkerDto {
  return worker !== null;
}

// Function ค้นหา ตาม ID จาก DB
export async function findById(
  id: number | string,
  connection?: DbConnection,
): Promise<MasterWorkerDto | null> {
  const db = client(connection);
  const worker = await db.masterWorker.findUnique({
    where: {
      id: toId(id),
    },
  });

  return mapMasterWorker(worker);
}

// Function ค้นหาหลาย ID พร้อมกันจาก DB
export async function listByIds(
  ids: Array<number | string>,
  connection?: DbConnection,
): Promise<MasterWorkerDto[]> {
  const uniqueIds = [...new Set(ids.map(toId))].filter((id) => Number.isFinite(id));

  if (uniqueIds.length === 0) {
    return [];
  }

  const db = client(connection);
  const workers = await db.masterWorker.findMany({
    where: {
      id: {
        in: uniqueIds,
      },
    },
  });

  return workers.map((worker) => mapMasterWorker(worker)).filter(isMasterWorkerDto);
}

// Function ค้นหา ตาม LaborCode (worker_code) จาก DB — ใช้เป็น "username" เทียบเท่าของ worker ตอน login
export async function findByLaborCode(
  laborCode: string,
  connection?: DbConnection,
): Promise<MasterWorkerDto | null> {
  const db = client(connection);
  const worker = await db.masterWorker.findUnique({
    where: {
      laborCode,
    },
  });

  return mapMasterWorker(worker);
}

// Function ดึง worker ที่ active ตาม LaborCode หลายคนพร้อมกัน ใช้หา lang ของแต่ละคนก่อน broadcast
// แจ้งเตือนแบบ localized (เช่น Mobile App Version update)
export async function listActiveByLaborCodes(
  laborCodes: string[],
  connection?: DbConnection,
): Promise<MasterWorkerDto[]> {
  const uniqueLaborCodes = [...new Set(laborCodes.filter(Boolean))];

  if (uniqueLaborCodes.length === 0) {
    return [];
  }

  const workers = await client(connection).masterWorker.findMany({
    where: {
      laborCode: {
        in: uniqueLaborCodes,
      },
      status: MASTER_WORKER_STATUS.ACTIVE,
    },
  });

  return workers.map((worker) => mapMasterWorker(worker)).filter(isMasterWorkerDto);
}

// Function อัปเดต password hash จาก DB
export async function updatePasswordHash(
  id: number | string,
  passwordHash: string,
  connection?: DbConnection,
): Promise<MasterWorkerDto> {
  const db = client(connection);
  const updated = await db.masterWorker.update({
    where: {
      id: toId(id),
    },
    data: {
      passwordHash,
    },
  });

  return requireMapped(mapMasterWorker(updated), "MasterWorker", "password update");
}

// Function อัปเดตภาษาของ worker จาก DB
export async function updateLang(
  id: number | string,
  lang: string,
  connection?: DbConnection,
): Promise<MasterWorkerDto> {
  const db = client(connection);
  const updated = await db.masterWorker.update({
    where: {
      id: toId(id),
    },
    data: {
      lang,
    },
  });

  return requireMapped(mapMasterWorker(updated), "MasterWorker", "lang update");
}

// Function โหลด WorkerCode (LaborCode) จาก worker id เพื่อไม่ส่ง id ภายในออกไปกับ event
export async function findWorkerCodeByWorkerId(
  workerId: number,
  connection?: DbConnection,
): Promise<string | null> {
  const worker = await findById(workerId, connection);

  return worker?.labor_code ?? null;
}

// Function สร้าง map จาก worker id เป็น WorkerCode ด้วย query เดียว
export async function findWorkerCodeMapByWorkerIds(
  workerIds: number[],
  connection?: DbConnection,
): Promise<Map<number, string | null>> {
  if (workerIds.length === 0) {
    return new Map();
  }

  const workers = await listByIds(workerIds, connection);

  return new Map(workers.map((worker) => [worker.id, worker.labor_code]));
}

// Function คืน WorkerCode ตามลำดับเดียวกับ worker id ที่ส่งเข้ามา
export async function listWorkerCodesByWorkerIds(
  workerIds: number[],
  connection?: DbConnection,
): Promise<Array<string | null>> {
  const workerCodeMap = await findWorkerCodeMapByWorkerIds(workerIds, connection);

  return workerIds.map((workerId) => workerCodeMap.get(workerId) ?? null);
}

// Function ค้นหา shift assignment ปัจจุบันของ worker จาก DB (field อยู่บน MasterWorker เอง)
export async function findCurrentScheduleByWorkerId(
  workerId: number | string,
  connection?: DbConnection,
): Promise<WorkScheduleDto | null> {
  const db = client(connection);
  const worker = await db.masterWorker.findUnique({
    where: {
      id: toId(workerId),
    },
  });

  return mapWorkerSchedule(worker);
}
