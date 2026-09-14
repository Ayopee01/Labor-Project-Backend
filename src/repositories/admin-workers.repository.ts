// Import Repositories
import * as baseMasterWorkerRepository from "./shared/master-worker.repository";
// Import Mappers
import { mapMasterWorker } from "./shared/mappers";
import { client, requireMapped, toId } from "./shared/repository-utils";
// Import Types
import type { Prisma } from "@prisma/client";
import type { DbConnection } from "../types/shared/common.type";
import { MASTER_WORKER_STATUS } from "../types/admin-workers.type";
import type { MasterWorkerCreateInput, MasterWorkerDto, MasterWorkerUpdateInput, UserListFilters, UserListShift } from "../types/admin-workers.type";

/* -------------------------------------- Config -------------------------------------- */

const SEARCH_MODE = "insensitive" as const;

// ค่า timeWork จริงบน MasterWorker ที่ query shift MORNING/EVENING ต้อง map ไปหา — ใช้ค่าเดียวกับ
// TIME_WORK_PRESETS ใน utils/shift.ts เพื่อให้ filter ตรงกับ shift_name ที่ response แสดงผลจริงเสมอ
const USER_LIST_SHIFT_TO_TIME_WORK: Record<UserListShift, "Morning" | "Evening"> = {
  MORNING: "Morning",
  EVENING: "Evening",
};

/* -------------------------------------- Functions -------------------------------------- */

// Function ตรวจว่า master worker DTO จาก DB
function isMasterWorkerDto(worker: MasterWorkerDto | null): worker is MasterWorkerDto {
  return worker !== null;
}

// Function สร้าง worker search where จาก DB
function buildWorkerSearchWhere(search: string): Prisma.MasterWorkerWhereInput[] {
  return [
    {
      laborCode: {
        contains: search,
        mode: SEARCH_MODE,
      },
    },
    {
      fullName: {
        contains: search,
        mode: SEARCH_MODE,
      },
    },
    {
      nationality: {
        contains: search,
        mode: SEARCH_MODE,
      },
    },
    {
      telephone: {
        contains: search,
        mode: SEARCH_MODE,
      },
    },
  ];
}

// Function สร้าง worker where จาก DB
function buildWorkerWhere(filters: Partial<UserListFilters> = {}): Prisma.MasterWorkerWhereInput {
  const where: Prisma.MasterWorkerWhereInput = {};

  if (filters.status !== undefined) {
    where.status = filters.status === "active"
      ? MASTER_WORKER_STATUS.ACTIVE
      : { not: MASTER_WORKER_STATUS.ACTIVE };
  }

  if (filters.search) {
    where.OR = buildWorkerSearchWhere(filters.search);
  }

  if (filters.worker_code) {
    where.laborCode = {
      contains: filters.worker_code,
      mode: SEARCH_MODE,
    };
  }

  if (filters.full_name) {
    where.fullName = {
      contains: filters.full_name,
      mode: SEARCH_MODE,
    };
  }

  if (filters.shirt_number) {
    where.coatNo = {
      contains: filters.shirt_number,
      mode: SEARCH_MODE,
    };
  }

  if (filters.shift) {
    where.timeWork = USER_LIST_SHIFT_TO_TIME_WORK[filters.shift];
  }

  return where;
}

// Function ตรวจว่า laborCode มีอยู่แล้วหรือไม่ จาก DB — laborCode คือ identifier หลักของ worker ใช้ตรวจก่อนสร้าง/แก้ไข
export async function laborCodeExists(
  laborCode: string,
  exceptWorkerId?: number | string | null,
  connection?: DbConnection,
): Promise<boolean> {
  const db = client(connection);
  const worker = await db.masterWorker.findFirst({
    where: {
      laborCode,
      ...(exceptWorkerId !== undefined &&
        exceptWorkerId !== null && {
          id: {
            not: toId(exceptWorkerId),
          },
        }),
    },
    select: {
      id: true,
    },
  });

  return Boolean(worker);
}

// Function สร้าง worker (source = "admin_created") จาก DB
export async function create(
  input: MasterWorkerCreateInput,
  connection?: DbConnection,
): Promise<MasterWorkerDto> {
  const db = client(connection);
  const created = await db.masterWorker.create({
    data: {
      laborCode: input.labor_code,
      fullName: input.full_name,
      telephone: input.telephone ?? null,
      nationality: input.nationality,
      laborColor: input.labor_color,
      workStartDate: input.work_start_date ? new Date(input.work_start_date) : null,
      workCode: input.work_code ?? null,
      coatNo: input.coat_no ?? null,
      timeWork: input.time_work ?? null,
      timeIn: input.time_in ?? null,
      timeOut: input.time_out ?? null,
      status: input.status ?? 1,
      source: "admin_created",
      // worker ที่สร้างทาง Admin ให้เป็น "TH" เสมอ (ไม่รับค่าจาก body) ต่างจาก worker ที่ sync มาจาก Master
      lang: "TH",
    },
  });

  return requireMapped(mapMasterWorker(created), "MasterWorker", "create");
}

// Function ดึงรายการ workers จาก DB
export async function listUsers(
  filters: UserListFilters,
  connection?: DbConnection,
): Promise<MasterWorkerDto[]> {
  const db = client(connection);
  const workers = await db.masterWorker.findMany({
    where: buildWorkerWhere(filters),
    orderBy: [
      {
        createdAt: "desc",
      },
      {
        id: "desc",
      },
    ],
    skip: filters.offset,
    take: filters.limit,
  });

  return workers.map((worker) => mapMasterWorker(worker)).filter(isMasterWorkerDto);
}

// Function นับ workers จาก DB
export async function countUsers(
  filters: UserListFilters,
  connection?: DbConnection,
): Promise<number> {
  const db = client(connection);

  return db.masterWorker.count({
    where: buildWorkerWhere(filters),
  });
}

// Function ค้นหา worker ตาม identifier (laborCode) จาก DB
export async function findByIdentifier(
  identifier: string,
  connection?: DbConnection,
): Promise<MasterWorkerDto | null> {
  return baseMasterWorkerRepository.findByLaborCode(identifier, connection);
}

// Function อัปเดตข้อมูล worker จาก DB
export async function update(
  id: number | string,
  fields: MasterWorkerUpdateInput,
  connection?: DbConnection,
): Promise<MasterWorkerDto> {
  const db = client(connection);
  const data: Prisma.MasterWorkerUpdateInput = {};

  if (fields.labor_code !== undefined) {
    data.laborCode = fields.labor_code;
  }

  if (fields.full_name !== undefined) {
    data.fullName = fields.full_name;
  }

  if (fields.telephone !== undefined) {
    data.telephone = fields.telephone;
  }

  if (fields.nationality !== undefined) {
    data.nationality = fields.nationality;
  }

  if (fields.labor_color !== undefined) {
    data.laborColor = fields.labor_color;
  }

  if (fields.work_start_date !== undefined) {
    data.workStartDate = fields.work_start_date ? new Date(fields.work_start_date) : null;
  }

  if (fields.status !== undefined) {
    data.status = fields.status;
  }

  const updated = await db.masterWorker.update({
    where: {
      id: toId(id),
    },
    data,
  });

  return requireMapped(mapMasterWorker(updated), "MasterWorker", "update");
}

// Function อัปเดต shift assignment ปัจจุบันของ worker จาก DB (field อยู่บน MasterWorker เอง)
export async function updateShift(
  id: number | string,
  shift: {
    time_work: string;
    time_in: string;
    time_out: string;
    work_start_date?: string | null;
  },
  connection?: DbConnection,
): Promise<MasterWorkerDto> {
  const db = client(connection);
  const updated = await db.masterWorker.update({
    where: {
      id: toId(id),
    },
    data: {
      timeWork: shift.time_work,
      timeIn: shift.time_in,
      timeOut: shift.time_out,
      ...(shift.work_start_date !== undefined
        ? { workStartDate: shift.work_start_date ? new Date(shift.work_start_date) : null }
        : {}),
    },
  });

  return requireMapped(mapMasterWorker(updated), "MasterWorker", "shift update");
}
