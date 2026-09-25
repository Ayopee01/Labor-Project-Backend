// Import Library
import { Prisma } from "@prisma/client";

// Import Config
import { ACTIVE_ASSIGNMENT_STATUSES, TERMINAL_JOB_STATUSES, TICKET_STATUS, VEHICLE_JOB_STATUS } from "../constants/status";
import { DEFAULT_PAGE_LIMIT } from "../constants/pagination";
import { ADMIN_ACTION_TYPE } from "../types/shared/admin-action-log.type";
// Import Mappers
import { mapMasterWorker, mapTicketJobAssignment } from "./shared/mappers";
import { client } from "./shared/repository-utils";
// Import Types
import type { DbConnection } from "../types/shared/common.type";
import type { MasterWorkerDto } from "../types/admin-workers.type";
import type { TicketJobAssignmentDto } from "../types/worker.type";
import type { AdminTicketJobFinancialRecord, DailyStallFeeFilters, DailyStallFeeQueryResult, DailyWorkerIncomeFilters, DailyWorkerIncomeRecord, HistoryStatusFilter, MonthlyStallFeeFilters, MonthlyStallFeeQueryResult, TicketJobHistoryListResult, TicketJobListFilters, TicketJobOperationFilters, TicketJobOperationRecord } from "../types/admin-jobs.type";
// Import Config
import { SHIRT_COLOR_SNAPSHOT } from "../constants/status";

/* -------------------------------------- Functions -------------------------------------- */

// Function สร้าง OR filter ค้นหา TicketJob จาก search term เดียว ครอบคลุมทุกระดับ (Ticket/Market/
// Booth/Product) — ใช้ร่วมกันระหว่าง listTicketJobs และ listTicketJobOperations
function buildTicketJobSearchFilter(search: string): Prisma.TicketJobWhereInput {
  return {
    OR: [
      {
        ticketNumber: {
          contains: search,
          mode: "insensitive",
        },
      },
      {
        licensePlate: {
          contains: search,
          mode: "insensitive",
        },
      },
      {
        marketJobs: {
          some: {
            OR: [
              {
                marketCode: {
                  contains: search,
                  mode: "insensitive",
                },
              },
              {
                marketName: {
                  contains: search,
                  mode: "insensitive",
                },
              },
              {
                gateTransactionRef: {
                  contains: search,
                  mode: "insensitive",
                },
              },
              {
                ticketNo: {
                  contains: search,
                  mode: "insensitive",
                },
              },
            ],
          },
        },
      },
      {
        tickets: {
          some: {
            OR: [
              {
                boothCode: {
                  contains: search,
                  mode: "insensitive",
                },
              },
              {
                boothName: {
                  contains: search,
                  mode: "insensitive",
                },
              },
              {
                products: {
                  some: {
                    OR: [
                      {
                        productCode: {
                          contains: search,
                          mode: "insensitive",
                        },
                      },
                      {
                        productName: {
                          contains: search,
                          mode: "insensitive",
                        },
                      },
                      {
                        packageCode: {
                          contains: search,
                          mode: "insensitive",
                        },
                      },
                      {
                        packageName: {
                          contains: search,
                          mode: "insensitive",
                        },
                      },
                    ],
                  },
                },
              },
            ],
          },
        },
      },
    ],
  };
}

// Function ประกอบ where clause ของแต่ละกลุ่มใน Work History (COMPLETED/CANCELLED/REJECT_PENDING) — REJECT_PENDING คือรถที่ยังไม่ terminal
// และมี BoothJob สถานะ REJECT ค้างอยู่ปัจจุบัน — ต้องตรงกับตรรกะที่ formatAdminTicketJobHistoryDetail ใช้ derive HistoryStatus ห้ามให้สองจุดเพี้ยนกัน
function buildHistoryStatusGroupWhere(
  group: "COMPLETED" | "CANCELLED" | "REJECT_PENDING",
): Prisma.TicketJobWhereInput {
  if (group === "COMPLETED") {
    return { status: VEHICLE_JOB_STATUS.COMPLETED };
  }

  if (group === "CANCELLED") {
    return { status: VEHICLE_JOB_STATUS.CANCELLED };
  }

  return {
    status: { notIn: TERMINAL_JOB_STATUSES },
    tickets: {
      some: {
        status: TICKET_STATUS.REJECT,
      },
    },
  };
}

// Function ประกอบ where clause ของ history_status query — ALL คือ OR ของสามกลุ่มเท่านั้น ไม่ใช่ทุกสถานะในฐานข้อมูล (ดู comment ของ buildHistoryStatusGroupWhere)
function buildHistoryStatusFilter(
  historyStatus: HistoryStatusFilter,
): Prisma.TicketJobWhereInput {
  if (historyStatus === "ALL") {
    return {
      OR: [
        buildHistoryStatusGroupWhere("COMPLETED"),
        buildHistoryStatusGroupWhere("CANCELLED"),
        buildHistoryStatusGroupWhere("REJECT_PENDING"),
      ],
    };
  }

  return buildHistoryStatusGroupWhere(historyStatus);
}

// Function รวม date range filter (createdAt) กับ andFilters ที่สะสมไว้ ให้เป็น where เดียว
// ใช้ร่วมกันระหว่าง listTicketJobs และ listTicketJobOperations (เรียก 2 ครั้งต่อฟังก์ชัน: ก่อน/หลังใส่ dropoff_point filter)
function buildTicketJobWhere(
  dateRange: { startAt?: Date; endAt?: Date },
  andFilters: Prisma.TicketJobWhereInput[],
): Prisma.TicketJobWhereInput {
  return {
    ...((dateRange.startAt || dateRange.endAt) && {
      createdAt: {
        ...(dateRange.startAt && {
          gte: dateRange.startAt,
        }),
        ...(dateRange.endAt && {
          lt: dateRange.endAt,
        }),
      },
    }),
    ...(andFilters.length > 0 && {
      AND: andFilters,
    }),
  };
}

// Function หา distinct dropoff_point ที่มีจริงภายใต้ where ที่ยังไม่ใส่ dropoff_point filter เอง
// ให้ dropdown เสนอตัวเลือกอื่นได้แม้กำลังกรองอยู่แล้ว — ใช้ร่วมกันระหว่าง listTicketJobs และ listTicketJobOperations
async function resolveAvailableDropoffPoints(
  db: DbConnection,
  whereWithoutDropoffPoint: Prisma.TicketJobWhereInput,
): Promise<string[]> {
  const dropoffPointRows = await db.marketJob.findMany({
    where: {
      ticketJob: whereWithoutDropoffPoint,
      dropoffPoint: {
        not: null,
      },
    },
    distinct: ["dropoffPoint"],
    select: {
      dropoffPoint: true,
    },
    orderBy: {
      dropoffPoint: "asc",
    },
  });

  return dropoffPointRows
    .map((row) => row.dropoffPoint)
    .filter((point): point is string => point !== null);
}

// Function ดึงรายการ vehicle jobs จาก DB
export async function listTicketJobs(
  filters: TicketJobListFilters = {},
  connection?: DbConnection,
): Promise<TicketJobHistoryListResult> {
  const db = client(connection);
  const andFilters: Prisma.TicketJobWhereInput[] = [];

  if (filters.status) {
    const statusFilter: Prisma.StringFilter = {
      equals: filters.status,
      mode: "insensitive",
    };

    andFilters.push({
      OR: [
        {
          status: statusFilter,
        },
        {
          marketJobs: {
            some: {
              status: statusFilter,
            },
          },
        },
        {
          tickets: {
            some: {
              status: statusFilter,
            },
          },
        },
        {
          assignments: {
            some: {
              status: statusFilter,
            },
          },
        },
      ],
    });
  }

  if (filters.history_status) {
    andFilters.push(buildHistoryStatusFilter(filters.history_status));
  }

  if (filters.search) {
    andFilters.push(buildTicketJobSearchFilter(filters.search));
  }

  // ใช้ where ก่อนใส่ dropoff_point filter เอง หา distinct dropoff_point ภายใต้ filter อื่น (date range/search/status) ให้ dropdown ยังเสนอตัวเลือกอื่นได้
  const whereWithoutDropoffPoint = buildTicketJobWhere(filters, andFilters);
  const availableDropoffPoints = await resolveAvailableDropoffPoints(
    db,
    whereWithoutDropoffPoint,
  );

  if (filters.dropoff_point) {
    andFilters.push({
      marketJobs: {
        some: {
          dropoffPoint: {
            equals: filters.dropoff_point,
            mode: "insensitive",
          },
        },
      },
    });
  }

  const where = buildTicketJobWhere(filters, andFilters);
  const shouldPaginate = filters.page !== undefined;
  const limit = filters.limit ?? DEFAULT_PAGE_LIMIT;
  const data = await db.ticketJob.findMany({
    where,
    orderBy: {
      createdAt: "desc",
    },
    include: {
      marketJobs: {
        orderBy: {
          id: "asc",
        },
        include: {
          ticketWorkers: {
            include: {
              worker: true,
              payments: true,
            },
          },
          tickets: {
            orderBy: {
              id: "asc",
            },
            include: {
              completionSubmissions: {
                orderBy: {
                  id: "asc",
                },
                include: {
                  submittedByAccount: true,
                  submittedByWorker: true,
                  workerSnapshots: {
                    orderBy: {
                      id: "asc",
                    },
                    include: {
                      ticketWorker: {
                        include: {
                          worker: true,
                        },
                      },
                    },
                  },
                },
              },
              products: {
                orderBy: {
                  id: "asc",
                },
                include: {
                  financial: {
                    include: {
                      workerPayments: {
                        include: {
                          ticketWorker: {
                            include: {
                              worker: true,
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      assignments: {
        orderBy: {
          id: "asc",
        },
        include: {
          worker: true,
          events: true,
        },
      },
    },
    ...(shouldPaginate && {
      skip: ((filters.page as number) - 1) * limit,
      take: limit,
    }),
  });

  if (!shouldPaginate) {
    return {
      data,
      available_dropoff_points: availableDropoffPoints,
    };
  }

  const total = await db.ticketJob.count({
    where,
  });

  return {
    data,
    total,
    available_dropoff_points: availableDropoffPoints,
  };
}

// Function ดึงรายการ vehicle job operations จาก DB
export async function listTicketJobOperations(
  filters: TicketJobOperationFilters = {},
  connection?: DbConnection,
): Promise<{
  records: TicketJobOperationRecord[];
  available_dropoff_points: string[];
}> {
  const db = client(connection);
  const andFilters: Prisma.TicketJobWhereInput[] = [];

  if (filters.search) {
    andFilters.push(buildTicketJobSearchFilter(filters.search));
  }

  // เหมือนกับ listTicketJobs — หา distinct dropoff_point จาก where ก่อนใส่ dropoff_point filter เอง ให้ dropdown เสนอตัวเลือกอื่นได้
  const whereWithoutDropoffPoint = buildTicketJobWhere(filters, andFilters);
  const availableDropoffPoints = await resolveAvailableDropoffPoints(
    db,
    whereWithoutDropoffPoint,
  );

  if (filters.dropoff_point) {
    andFilters.push({
      marketJobs: {
        some: {
          dropoffPoint: {
            equals: filters.dropoff_point,
            mode: "insensitive",
          },
        },
      },
    });
  }

  const where = buildTicketJobWhere(filters, andFilters);

  const records = await db.ticketJob.findMany({
    where,
    orderBy: {
      createdAt: "desc",
    },
    include: {
      marketJobs: {
        orderBy: {
          id: "asc",
        },
        include: {
          tickets: {
            orderBy: {
              id: "asc",
            },
            include: {
              products: {
                orderBy: {
                  id: "asc",
                },
              },
            },
          },
        },
      },
      assignments: {
        orderBy: [
          {
            createdAt: "asc",
          },
          {
            id: "asc",
          },
        ],
        include: {
          worker: true,
        },
      },
    },
  });

  return {
    records,
    available_dropoff_points: availableDropoffPoints,
  };
}

// Function ดึง Financial breakdown ของ TicketJob ตาม TicketNumber จาก DB
export async function findTicketJobFinancialByRef(
  ticketNumber: string,
  connection?: DbConnection,
): Promise<AdminTicketJobFinancialRecord | null> {
  const db = client(connection);

  return db.ticketJob.findUnique({
    where: {
      ticketNumber,
    },
    include: {
      marketJobs: {
        orderBy: {
          id: "asc",
        },
        include: {
          ticketWorkers: {
            orderBy: {
              id: "asc",
            },
            include: {
              worker: true,
              payments: {
                orderBy: {
                  id: "asc",
                },
              },
            },
          },
          tickets: {
            orderBy: {
              id: "asc",
            },
            include: {
              products: {
                orderBy: {
                  id: "asc",
                },
                include: {
                  financial: {
                    include: {
                      workerPayments: {
                        orderBy: {
                          id: "asc",
                        },
                        include: {
                          ticketWorker: {
                            include: {
                              worker: true,
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
}

// Function ค้นหา worker ตาม code จาก DB
export async function findWorkerByCode(
  workerCode: string,
  connection?: DbConnection,
): Promise<MasterWorkerDto | null> {
  const db = client(connection);
  const worker = await db.masterWorker.findUnique({
    where: {
      laborCode: workerCode,
    },
  });

  return mapMasterWorker(worker);
}

// Function ค้นหา active assignment ตาม vehicle job ref และ WorkerCode จาก DB
export async function findActiveAssignmentByTicketJobRefAndWorkerCode(
  ticketNumber: string,
  workerCode: string,
  connection?: DbConnection,
): Promise<TicketJobAssignmentDto | null> {
  const db = client(connection);
  const assignment = await db.ticketJobAssignment.findFirst({
    where: {
      ticketJob: {
        ticketNumber,
      },
      worker: {
        laborCode: workerCode,
      },
      status: {
        in: ACTIVE_ASSIGNMENT_STATUSES,
      },
    },
    orderBy: {
      id: "desc",
    },
  });

  return mapTicketJobAssignment(assignment);
}

// Function สร้าง where ของ listDailyWorkerIncome — แยก workerCode/shift ออกได้อิสระต่อกัน
// เพื่อคำนวณ available_worker_codes/available_shifts จาก filter อื่นไม่รวมของตัวเอง (แบบเดียวกับ dropoff_point) ให้ dropdown ยังเสนอตัวเลือกอื่นได้
function buildDailyWorkerIncomeWhere(
  filters: DailyWorkerIncomeFilters,
  options: { includeWorkerCode: boolean; includeShift: boolean },
): Prisma.TicketWorkerWhereInput {
  const dateRangeFilter: Prisma.TicketWorkerWhereInput[] =
    filters.startAt || filters.endAt
      ? [
        {
          completedAt: {
            ...(filters.startAt && { gte: filters.startAt }),
            ...(filters.endAt && { lt: filters.endAt }),
          },
        },
        {
          AND: [
            { completedAt: null },
            {
              joinedAt: {
                ...(filters.startAt && { gte: filters.startAt }),
                ...(filters.endAt && { lt: filters.endAt }),
              },
            },
          ],
        },
      ]
      : [];
  const workerFilter: Prisma.MasterWorkerWhereInput = {
    ...(options.includeWorkerCode && filters.workerCode && {
      laborCode: {
        equals: filters.workerCode,
        mode: "insensitive",
      },
    }),
    ...(options.includeShift && filters.shift !== undefined && {
      shiftName: filters.shift,
    }),
  };

  return {
    ...(Object.keys(workerFilter).length > 0 && {
      worker: workerFilter,
    }),
    ...(filters.status && {
      status: {
        equals: filters.status,
        mode: "insensitive",
      },
    }),
    ...(filters.search && {
      OR: [
        {
          worker: {
            laborCode: {
              contains: filters.search,
              mode: "insensitive",
            },
          },
        },
        {
          worker: {
            fullName: {
              contains: filters.search,
              mode: "insensitive",
            },
          },
        },
        {
          marketJob: {
            ticketNo: {
              contains: filters.search,
              mode: "insensitive",
            },
          },
        },
      ],
    }),
    ...(dateRangeFilter.length > 0 && {
      OR: dateRangeFilter,
    }),
  };
}

// Function ดึงรายได้ Worker รายวันจาก DB — หนึ่งแถว = สมาชิกภาพของ Worker หนึ่งคนใน Business Ticket หนึ่งใบ (TicketWorker)
// กรองตามช่วงวันที่จาก completedAt ถ้ามี ไม่งั้นใช้ joinedAt แทน (Business Ticket ที่ยังไม่ Finalize จะยังไม่มี completedAt)
export async function listDailyWorkerIncome(
  filters: DailyWorkerIncomeFilters,
  connection?: DbConnection,
): Promise<{
  data: DailyWorkerIncomeRecord[];
  available_worker_codes: string[];
  available_shifts: string[];
}> {
  const db = client(connection);
  const where = buildDailyWorkerIncomeWhere(filters, {
    includeWorkerCode: true,
    includeShift: true,
  });
  // ไม่ paginate ที่ชั้น DB เพราะ payment_status เป็นค่า derive จากหลายตาราง ไม่ใช่ column ให้ WHERE ได้โดยตรง
  // ต้อง fetch ทุกแถวที่เข้าเงื่อนไข filter อื่นก่อน แล้วค่อย derive/กรอง/แบ่งหน้าใน service layer (แบบเดียวกับ listTicketJobOperations กับ operation_status)
  const [data, workerCodeRows, shiftRows] = await Promise.all([
    db.ticketWorker.findMany({
      where,
      orderBy: [
        {
          completedAt: "desc",
        },
        {
          joinedAt: "desc",
        },
        {
          id: "desc",
        },
      ],
      include: {
        worker: true,
        marketJob: {
          include: {
            ticketJob: {
              include: {
                assignments: {
                  include: {
                    worker: true,
                  },
                },
                // Fallback source เมื่อ ticket_no นี้ถูกยกเลิกทางอ้อมจากการยกเลิกทั้ง TicketNumber (marketJob.adminActionLogs ด้านล่างจะว่างเปล่าเพราะ cancelTicketJob ไม่เขียน log แยกต่อ MarketJob)
                // เอาแค่ log ล่าสุดของรถคันนี้
                adminActionLogs: {
                  where: {
                    actionType: ADMIN_ACTION_TYPE.VEHICLE_JOB_CANCELLED,
                  },
                  include: {
                    actor: true,
                  },
                  orderBy: {
                    createdAt: "desc",
                  },
                  take: 1,
                },
              },
            },
            tickets: {
              include: {
                completionSubmissions: true,
                adminActionLogs: {
                  where: {
                    actionType: ADMIN_ACTION_TYPE.OVERRIDE_COUNT,
                  },
                  include: {
                    actor: true,
                  },
                  orderBy: {
                    createdAt: "desc",
                  },
                },
              },
            },
            // ใช้เป็น source ของ Cancellation.CancelledByType/CancelledByName และ riskText เมื่อ payment_status = cancel
            // เอาแค่ log ล่าสุดของการยกเลิก TicketNo นี้ ไม่ว่ายกเลิกทั้งใบตรงๆ (MARKET_JOB_CANCELLED) หรือ cascade จาก Booth สุดท้าย (STALL_JOB_CANCELLED)
            adminActionLogs: {
              where: {
                actionType: {
                  in: [
                    ADMIN_ACTION_TYPE.MARKET_JOB_CANCELLED,
                    ADMIN_ACTION_TYPE.STALL_JOB_CANCELLED,
                    ADMIN_ACTION_TYPE.OVERRIDE_COUNT,
                  ],
                },
              },
              include: {
                actor: true,
              },
              orderBy: {
                createdAt: "desc",
              },
            },
          },
        },
      },
    }),
    db.ticketWorker.findMany({
      // ไม่รวมทั้ง workerCode และ shift — สอง dropdown นี้เป็นอิสระต่อกัน คำนวณจาก date/search/status
      // เท่านั้น ไม่ narrow ตามกันเอง (ต่างจาก dropoff_point ที่มี dropdown เดียว) เพื่อให้เห็นตัวเลือก
      // ครบทุกตัวเสมอ ไม่ต้องกังวลว่าเลือกสอง filter พร้อมกันแล้วจะไม่มีข้อมูลตรงกัน
      where: buildDailyWorkerIncomeWhere(filters, {
        includeWorkerCode: false,
        includeShift: false,
      }),
      distinct: ["workerId"],
      select: {
        worker: {
          select: {
            laborCode: true,
          },
        },
      },
    }),
    db.ticketWorker.findMany({
      where: buildDailyWorkerIncomeWhere(filters, {
        includeWorkerCode: false,
        includeShift: false,
      }),
      distinct: ["workerId"],
      select: {
        worker: {
          select: {
            shiftName: true,
          },
        },
      },
    }),
  ]);
  const availableWorkerCodes = Array.from(
    new Set(workerCodeRows.map((row) => row.worker.laborCode)),
  ).sort();
  const availableShifts = Array.from(
    new Set(
      shiftRows
        .map((row) => row.worker.shiftName)
        .filter((shiftName): shiftName is string => shiftName !== null),
    ),
  ).sort();

  return {
    data,
    available_worker_codes: availableWorkerCodes,
    available_shifts: availableShifts,
  };
}

/* -------------------------------------- Daily Stall Fee -------------------------------------- */

// Function แยก search term เป็น token ด้วยช่องว่างหรือ comma — ต้อง match ทุก token (AND ระหว่าง token, OR ระหว่าง field)
function splitDailyStallFeeSearchTokens(search: string): string[] {
  return search
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

// Function สร้าง OR filter ของ search token หนึ่งตัว ครอบคลุมเลขแผง/ทะเบียนรถ/เลขตั๋ว/สินค้า/บรรจุภัณฑ์ — anchor ที่ TicketProductFinancial (ใช้กับ query หลัก)
function buildDailyStallFeeTokenFilter(token: string): Prisma.TicketProductFinancialWhereInput {
  const contains = { contains: token, mode: "insensitive" as const };

  return {
    OR: [
      { product: { ticket: { boothCode: contains } } },
      { product: { ticket: { marketJob: { ticketJob: { licensePlate: contains } } } } },
      { product: { ticket: { marketJob: { ticketNo: contains } } } },
      { product: { productCode: contains } },
      { product: { productName: contains } },
      { product: { packageCode: contains } },
      { product: { packageName: contains } },
    ],
  };
}

// Function เดียวกับด้านบนแต่ anchor ที่ TicketProduct — ใช้กับ query available_products/available_packages ที่ต้อง distinct บน productCode/packageCode
function buildDailyStallFeeProductTokenFilter(token: string): Prisma.TicketProductWhereInput {
  const contains = { contains: token, mode: "insensitive" as const };

  return {
    OR: [
      { ticket: { boothCode: contains } },
      { ticket: { marketJob: { ticketJob: { licensePlate: contains } } } },
      { ticket: { marketJob: { ticketNo: contains } } },
      { productCode: contains },
      { productName: contains },
      { packageCode: contains },
      { packageName: contains },
    ],
  };
}

// Function สร้าง where ของ query หลัก (data/summary/stall_count) — ใช้ product_code และ package_code พร้อมกันเสมอ
// ต่างจาก buildDailyStallFeeProductWhere ด้านล่างที่คำนวณ available_products/available_packages แบบ faceted
function buildDailyStallFeeWhere(
  filters: DailyStallFeeFilters,
  options: { includeProductCode: boolean; includePackageCode: boolean },
): Prisma.TicketProductFinancialWhereInput {
  const searchTokens = filters.search ? splitDailyStallFeeSearchTokens(filters.search) : [];
  const productWhere: Prisma.TicketProductWhereInput = {
    ...(options.includeProductCode && filters.productCode && { productCode: filters.productCode }),
    ...(options.includePackageCode && filters.packageCode && { packageCode: filters.packageCode }),
  };

  return {
    finalizedAt: {
      gte: filters.startAt,
      lt: filters.endAt,
    },
    ...(Object.keys(productWhere).length > 0 && { product: productWhere }),
    ...(searchTokens.length > 0 && { AND: searchTokens.map(buildDailyStallFeeTokenFilter) }),
  };
}

// Function สร้าง where ของ available_products/available_packages แบบ faceted — date range + search เสมอ
// ส่วน product_code/package_code กรองแค่มิติตรงข้าม ไม่ narrow ด้วยค่าที่เลือกในมิติของตัวเอง
function buildDailyStallFeeProductWhere(
  filters: Pick<DailyStallFeeFilters, "startAt" | "endAt" | "search" | "productCode" | "packageCode">,
  options: { includeProductCode: boolean; includePackageCode: boolean },
): Prisma.TicketProductWhereInput {
  const searchTokens = filters.search ? splitDailyStallFeeSearchTokens(filters.search) : [];

  return {
    financial: {
      finalizedAt: {
        gte: filters.startAt,
        lt: filters.endAt,
      },
    },
    ...(options.includeProductCode && filters.productCode && { productCode: filters.productCode }),
    ...(options.includePackageCode && filters.packageCode && { packageCode: filters.packageCode }),
    ...(searchTokens.length > 0 && { AND: searchTokens.map(buildDailyStallFeeProductTokenFilter) }),
  };
}

// Function ดึงรายงานค่าลงสินค้าแผงค้ารายวัน — หนึ่งแถว = หนึ่ง TicketProductFinancial ที่ finalize แล้ว
// filter/join ที่ DB ทั้งหมด ไม่ load worker payments เพราะรายงานนี้ไม่ใช้รายได้แรงงาน
export async function listDailyStallFees(
  filters: DailyStallFeeFilters,
  connection?: DbConnection,
): Promise<DailyStallFeeQueryResult> {
  const db = client(connection);
  const where = buildDailyStallFeeWhere(filters, {
    includeProductCode: true,
    includePackageCode: true,
  });
  // available_products แคบตาม package_code ที่เลือก, available_packages แคบตาม product_code ที่เลือก — faceted filter คนละทิศทางกัน
  const productOptionsWhere = buildDailyStallFeeProductWhere(filters, {
    includeProductCode: false,
    includePackageCode: true,
  });
  const packageOptionsWhere = buildDailyStallFeeProductWhere(filters, {
    includeProductCode: true,
    includePackageCode: false,
  });

  const [data, aggregate, stallIdRows, productRows, packageRows] = await Promise.all([
    db.ticketProductFinancial.findMany({
      where,
      orderBy: [{ finalizedAt: "desc" }, { id: "desc" }],
      include: {
        product: {
          include: {
            ticket: {
              include: {
                marketJob: {
                  include: {
                    ticketJob: true,
                  },
                },
              },
            },
          },
        },
      },
      skip: (filters.page - 1) * filters.limit,
      take: filters.limit,
    }),
    db.ticketProductFinancial.aggregate({
      where,
      _count: {
        _all: true,
      },
      _sum: {
        confirmedQuantity: true,
        stallFeeRounded: true,
      },
    }),
    // stall_count = COUNT(DISTINCT BoothJob.id) — Prisma ไม่รองรับ distinct บน field ของ relation
    // ที่ไม่ใช่ query root โดยตรง เลยดึงเฉพาะ id มา dedupe เองแทนที่จะโหลดทั้งแถว
    db.ticketProductFinancial.findMany({
      where,
      select: {
        product: {
          select: {
            ticket: {
              select: {
                id: true,
              },
            },
          },
        },
      },
    }),
    db.ticketProduct.findMany({
      where: productOptionsWhere,
      distinct: ["productCode"],
      select: {
        productCode: true,
        productName: true,
      },
    }),
    db.ticketProduct.findMany({
      where: packageOptionsWhere,
      distinct: ["packageCode"],
      select: {
        packageCode: true,
        packageName: true,
      },
    }),
  ]);

  const stallCount = new Set(stallIdRows.map((row) => row.product.ticket.id)).size;
  // เรียงด้วยชื่อภาษาไทยแล้วตามด้วย code ในโค้ด (ไม่พึ่ง DB collation ที่อาจไม่รองรับ Thai locale sort)
  const availableProducts = productRows
    .map((row) => ({ product_code: row.productCode, product_name: row.productName }))
    .sort(
      (a, b) =>
        a.product_name.localeCompare(b.product_name, "th") ||
        a.product_code.localeCompare(b.product_code, "th"),
    );
  const availablePackages = packageRows
    .map((row) => ({ package_code: row.packageCode, package_name: row.packageName }))
    .sort(
      (a, b) =>
        a.package_name.localeCompare(b.package_name, "th") ||
        a.package_code.localeCompare(b.package_code, "th"),
    );

  return {
    data,
    total: aggregate._count._all,
    summary: {
      row_count: aggregate._count._all,
      stall_count: stallCount,
      confirmed_quantity_total: aggregate._sum.confirmedQuantity ?? new Prisma.Decimal(0),
      stall_fee_total: aggregate._sum.stallFeeRounded ?? new Prisma.Decimal(0),
    },
    available_products: availableProducts,
    available_packages: availablePackages,
  };
}

/* -------------------------------------- Monthly Stall Fee -------------------------------------- */

// Fragment FROM/JOIN ร่วมของทุก query รายงานค่าลงสินค้าแผงค้ารายเดือน — เดินสาย
// ticket_product_financials -> ticket_products -> gate_tickets -> market_jobs
const MONTHLY_STALL_FEE_FROM = Prisma.sql`
  FROM ticket_product_financials tpf
  JOIN ticket_products tp ON tp.id = tpf.ticket_product_id
  JOIN booth_jobs gt ON gt.id = tp.ticket_id
  JOIN market_jobs mj ON mj.id = gt.market_job_id
`;

// Function สร้าง WHERE fragment ของรายงานรายเดือน — แยก flag ต่อ filter เพื่อคำนวณ available_markets/available_stalls/available_shirt_colors แบบ faceted เหมือน buildDailyStallFeeWhere
function buildMonthlyStallFeeWhere(
  filters: MonthlyStallFeeFilters,
  options: {
    includeMarketSearch: boolean;
    includeBoothSearch: boolean;
    includeShirtColor: boolean;
  },
): Prisma.Sql {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`tpf.finalized_at >= ${filters.startAt}`,
    Prisma.sql`tpf.finalized_at < ${filters.endAt}`,
  ];

  if (options.includeMarketSearch && filters.marketSearch) {
    const pattern = `%${filters.marketSearch}%`;

    conditions.push(
      Prisma.sql`(mj.market_code ILIKE ${pattern} OR mj.market_name ILIKE ${pattern})`,
    );
  }

  if (options.includeBoothSearch && filters.boothSearch) {
    conditions.push(Prisma.sql`gt.booth_code ILIKE ${`%${filters.boothSearch}%`}`);
  }

  if (options.includeShirtColor && filters.shirtColor) {
    conditions.push(
      Prisma.sql`COALESCE(tpf.shirt_color_snapshot, 'UNKNOWN') = ${filters.shirtColor}`,
    );
  }

  return Prisma.join(conditions, " AND ");
}

// ลำดับ canonical ของ dropdown available_shirt_colors — สีจริงจาก master data (ไม่รู้ล่วงหน้าว่ามีอะไรบ้าง)
// เรียงตามตัวอักษร ส่วน MIXED/UNKNOWN เป็นป้ายที่แอปคำนวณเอง (ไม่ใช่สีจริง) ให้อยู่ท้ายสุดเสมอ
const SHIRT_COLOR_TRAILING_ORDER = [
  SHIRT_COLOR_SNAPSHOT.MIXED,
  SHIRT_COLOR_SNAPSHOT.UNKNOWN,
] as const;

// Function ดึงรายงานค่าลงสินค้าแผงค้ารายเดือนจาก DB — ใช้ raw SQL เพราะ GROUP BY ข้าม relation (Prisma groupBy ทำตรงๆ ไม่ได้)
// aggregate, facet filters และ pagination ทำที่ DB ทั้งหมด ไม่โหลดมารวมใน memory
export async function listMonthlyStallFees(
  filters: MonthlyStallFeeFilters,
  connection?: DbConnection,
): Promise<MonthlyStallFeeQueryResult> {
  const db = client(connection);

  const dataWhere = buildMonthlyStallFeeWhere(filters, {
    includeMarketSearch: true,
    includeBoothSearch: true,
    includeShirtColor: true,
  });
  const marketOptionsWhere = buildMonthlyStallFeeWhere(filters, {
    includeMarketSearch: false,
    includeBoothSearch: true,
    includeShirtColor: true,
  });
  const stallOptionsWhere = buildMonthlyStallFeeWhere(filters, {
    includeMarketSearch: true,
    includeBoothSearch: false,
    includeShirtColor: true,
  });
  const shirtColorOptionsWhere = buildMonthlyStallFeeWhere(filters, {
    includeMarketSearch: true,
    includeBoothSearch: true,
    includeShirtColor: false,
  });

  const [dataRows, summaryRows, marketRows, stallRows, shirtColorRows] = await Promise.all([
    db.$queryRaw<
      Array<{
        market_code: string;
        market_name: string;
        booth_code: string;
        shirt_color: string;
        financial_item_count: number;
        debit_amount: Prisma.Decimal;
      }>
    >(Prisma.sql`
      SELECT market_code, market_name, booth_code, shirt_color, financial_item_count, debit_amount
      FROM (
        SELECT
          mj.market_code AS market_code,
          MAX(mj.market_name) AS market_name,
          gt.booth_code AS booth_code,
          COALESCE(tpf.shirt_color_snapshot, 'UNKNOWN') AS shirt_color,
          COUNT(*)::int AS financial_item_count,
          COALESCE(SUM(tpf.stall_fee_rounded), 0) AS debit_amount
        ${MONTHLY_STALL_FEE_FROM}
        WHERE ${dataWhere}
        GROUP BY mj.market_code, gt.booth_code, COALESCE(tpf.shirt_color_snapshot, 'UNKNOWN')
      ) grouped
      ORDER BY market_code, booth_code, shirt_color
      LIMIT ${filters.limit} OFFSET ${(filters.page - 1) * filters.limit}
    `),
    db.$queryRaw<
      Array<{
        row_count: number;
        stall_count: number;
        financial_item_count: number;
        debit_amount_total: Prisma.Decimal;
      }>
    >(Prisma.sql`
      SELECT
        COUNT(DISTINCT (mj.market_code, gt.booth_code, COALESCE(tpf.shirt_color_snapshot, 'UNKNOWN')))::int AS row_count,
        COUNT(DISTINCT (mj.market_code, gt.booth_code))::int AS stall_count,
        COUNT(*)::int AS financial_item_count,
        COALESCE(SUM(tpf.stall_fee_rounded), 0) AS debit_amount_total
      ${MONTHLY_STALL_FEE_FROM}
      WHERE ${dataWhere}
    `),
    db.$queryRaw<Array<{ market_code: string; market_name: string }>>(Prisma.sql`
      SELECT DISTINCT mj.market_code AS market_code, mj.market_name AS market_name
      ${MONTHLY_STALL_FEE_FROM}
      WHERE ${marketOptionsWhere}
    `),
    db.$queryRaw<Array<{ market_code: string; booth_code: string }>>(Prisma.sql`
      SELECT DISTINCT mj.market_code AS market_code, gt.booth_code AS booth_code
      ${MONTHLY_STALL_FEE_FROM}
      WHERE ${stallOptionsWhere}
    `),
    db.$queryRaw<Array<{ shirt_color: string }>>(Prisma.sql`
      SELECT DISTINCT COALESCE(tpf.shirt_color_snapshot, 'UNKNOWN') AS shirt_color
      ${MONTHLY_STALL_FEE_FROM}
      WHERE ${shirtColorOptionsWhere}
    `),
  ]);

  const summary = summaryRows[0] ?? {
    row_count: 0,
    stall_count: 0,
    financial_item_count: 0,
    debit_amount_total: new Prisma.Decimal(0),
  };

  const availableMarkets = marketRows
    .map((row) => ({ market_code: row.market_code, market_name: row.market_name }))
    .sort(
      (a, b) =>
        a.market_name.localeCompare(b.market_name, "th") ||
        a.market_code.localeCompare(b.market_code, "th"),
    );
  const availableStalls = stallRows
    .map((row) => ({ market_code: row.market_code, booth_code: row.booth_code }))
    .sort(
      (a, b) =>
        a.market_code.localeCompare(b.market_code, "th") ||
        a.booth_code.localeCompare(b.booth_code, "th"),
    );
  const availableShirtColors = shirtColorRows
    .map((row) => row.shirt_color)
    .sort((a, b) => {
      const aTrailingIndex = SHIRT_COLOR_TRAILING_ORDER.indexOf(a as never);
      const bTrailingIndex = SHIRT_COLOR_TRAILING_ORDER.indexOf(b as never);

      if (aTrailingIndex === -1 && bTrailingIndex === -1) {
        return a.localeCompare(b, "th");
      }

      return (
        (aTrailingIndex === -1 ? SHIRT_COLOR_TRAILING_ORDER.length : aTrailingIndex) -
        (bTrailingIndex === -1 ? SHIRT_COLOR_TRAILING_ORDER.length : bTrailingIndex)
      );
    });

  return {
    data: dataRows,
    total: summary.row_count,
    summary: {
      row_count: summary.row_count,
      stall_count: summary.stall_count,
      financial_item_count: summary.financial_item_count,
      debit_amount_total: new Prisma.Decimal(summary.debit_amount_total),
    },
    available_markets: availableMarkets,
    available_stalls: availableStalls,
    available_shirt_colors: availableShirtColors,
  };
}
