// Import Library
import { Prisma } from "@prisma/client";
// Import Config
import { DAILY_WORKER_INCOME_PAYMENT_STATUS, SHIRT_COLOR_SNAPSHOT, TERMINAL_JOB_STATUSES, TICKET_STATUS, TICKET_WORKER_STATUS, VEHICLE_JOB_STATUS } from "../constants/status";
import { DEFAULT_PAGE_LIMIT } from "../constants/pagination";
// Import Repositories
import { client } from "./shared/repository-utils";
// Import Mappers
import { mapMasterWorker } from "./shared/mappers";
// Import Types
import { ADMIN_ACTION_TYPE, GATE_TICKET_UPDATE_REASON_CODE } from "../types/shared/admin-action-log.type";
import type { DbConnection } from "../types/shared/common.type";
import type { GateTicketChangeDetail, GateTicketChangeSummary } from "../types/gate.type";
import type { MasterWorkerDto } from "../types/admin-workers.type";
import type { AdminHistoryGateTicketUpdateRecord, AdminTicketJobFinancialRecord,DailyStallFeeFilters, DailyStallFeeQueryResult, DailyWorkerIncomeFilters, DailyWorkerIncomePaymentStatus, DailyWorkerIncomeQueryResult, HistoryStatusFilter, MonthlyStallFeeFilters, MonthlyStallFeeQueryResult, TicketJobHistoryListResult, TicketJobHistorySummaryRecord, TicketJobListFilters, TicketJobOperationFilters, TicketJobOperationRecord } from "../types/admin-jobs.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function สร้าง OR filter ค้นหา TicketJob จาก search term ครอบคลุม Ticket/Market/Booth/Product
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

// Function สร้าง where ของกลุ่ม Work History (ต้องตรงกับ HistoryStatus ใน formatAdminTicketJobHistoryDetail)
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

// Function สร้าง where ของ history_status (ALL = OR ของสามกลุ่ม ไม่ใช่ทุกสถานะ)
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

// Function รวม date range (createdAt) กับ filter อื่นเป็น where เดียว
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

// Function หา dropoff_point ที่มีจริงจาก filter อื่น เพื่อให้ dropdown ยังเสนอตัวเลือกอื่นได้
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

// Function รวมยอด Work History ทั้งชุดหลังกรองด้วย aggregate ที่ DB (สูตรเดียวกับ sumBoothFinancials)
async function aggregateTicketJobHistorySummary(
  db: DbConnection,
  where: Prisma.TicketJobWhereInput,
): Promise<TicketJobHistorySummaryRecord> {
  const [statusGroups, stallFee, productFinancial] = await Promise.all([
    db.ticketJob.groupBy({
      by: ["status"],
      where,
      _count: {
        _all: true,
      },
    }),
    // ยอดแผงนับเฉพาะแผงที่ปิดยอดแล้ว
    db.boothJob.aggregate({
      where: {
        financializedAt: {
          not: null,
        },
        marketJob: {
          ticketJob: where,
        },
      },
      _sum: {
        finalStallAmount: true,
      },
    }),
    db.ticketProductFinancial.aggregate({
      where: {
        product: {
          ticket: {
            marketJob: {
              ticketJob: where,
            },
          },
        },
      },
      _sum: {
        workerPayoutTotal: true,
        fundAmount: true,
      },
    }),
  ]);
  const countByStatus = (status: string) =>
    statusGroups.find((group) => group.status === status)?._count._all ?? 0;

  return {
    total: statusGroups.reduce((sum, group) => sum + group._count._all, 0),
    completed: countByStatus(VEHICLE_JOB_STATUS.COMPLETED),
    cancelled: countByStatus(VEHICLE_JOB_STATUS.CANCELLED),
    stall_fee_total: stallFee._sum.finalStallAmount ?? new Prisma.Decimal(0),
    worker_income_total: productFinancial._sum.workerPayoutTotal ?? new Prisma.Decimal(0),
    fund_total: productFinancial._sum.fundAmount ?? new Prisma.Decimal(0),
  };
}

// Function ดึงรายการงานรถสำหรับหน้าประวัติของ Admin
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

  // หา dropoff_point จาก where ที่ยังไม่กรอง dropoff_point
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
  const dataPromise = db.ticketJob.findMany({
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
              workerExclusions: true,
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
      data: await dataPromise,
      available_dropoff_points: availableDropoffPoints,
    };
  }

  const [data, summary] = await Promise.all([
    dataPromise,
    aggregateTicketJobHistorySummary(db, where),
  ]);

  return {
    data,
    total: summary.total,
    summary,
    available_dropoff_points: availableDropoffPoints,
  };
}

// Function ดึงการแก้ไขตั๋วจาก Gate ที่เปลี่ยนแปลงจริงของหลาย TicketJob ใน query เดียว แล้วจัดกลุ่มตาม TicketJob
export async function listGateTicketUpdatesByTicketJobIds(
  ticketJobIds: number[],
  connection?: DbConnection
): Promise<Map<number, AdminHistoryGateTicketUpdateRecord[]>> {
  const updatesByTicketJobId = new Map<number, AdminHistoryGateTicketUpdateRecord[]>(
    ticketJobIds.map((ticketJobId) => [ticketJobId, []])
  );

  if (ticketJobIds.length === 0) {
    return updatesByTicketJobId;
  }

  const db = client(connection);
  const records = await db.gateRequestLog.findMany({
    where: {
      ticketJobId: {
        in: ticketJobIds,
      },
      requestType: "UPDATE",
      result: "UPDATED",
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      ticketJobId: true,
      gateNo: true,
      changeSummary: true,
      changeDetails: true,
      createdAt: true,
      gateClient: { select: { name: true } },
      marketJob: { select: { ticketNo: true } },
    },
  });

  for (const record of records) {
    if (record.ticketJobId === null) {
      continue;
    }

    updatesByTicketJobId.get(record.ticketJobId)?.push({
      id: record.id,
      gate_no: record.gateNo,
      gate_client_name: record.gateClient?.name ?? null,
      ticket_no: record.marketJob?.ticketNo ?? null,
      change_summary: record.changeSummary as unknown as GateTicketChangeSummary,
      change_details: record.changeDetails as unknown as GateTicketChangeDetail[],
      created_at: record.createdAt.toISOString(),
    });
  }

  return updatesByTicketJobId;
}

// Function ดึงรายการงานรถสำหรับบอร์ดจัดการของ Admin
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

  // หา dropoff_point จาก where ที่ยังไม่กรอง dropoff_point
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
      // แถวที่ Gate ยกเลิกตอนแก้ไขตั๋ว (ไม่แสดงบนบอร์ด เห็นเฉพาะของใหม่)
      adminActionLogs: {
        where: {
          reasonCode: GATE_TICKET_UPDATE_REASON_CODE,
          actionType: {
            in: [ADMIN_ACTION_TYPE.STALL_JOB_CANCELLED, ADMIN_ACTION_TYPE.MARKET_JOB_CANCELLED],
          },
        },
        select: {
          actionType: true,
          reasonCode: true,
          boothJobId: true,
          marketJobId: true,
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

// Config include ของ DailyWorkerIncomeRecord (โหลดเฉพาะแถวของหน้าปัจจุบัน)
const DAILY_WORKER_INCOME_RECORD_INCLUDE = {
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
          // log ยกเลิกทั้งรถล่าสุด (ไม่มี log แยกต่อ MarketJob)
          adminActionLogs: {
            where: {
              actionType: ADMIN_ACTION_TYPE.VEHICLE_JOB_CANCELLED,
            },
            include: {
              actor: true,
              actorGateClient: true,
            },
            orderBy: [
              {
                createdAt: "desc",
              },
              {
                id: "desc",
              },
            ],
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
              actorGateClient: true,
            },
            orderBy: {
              createdAt: "desc",
            },
          },
        },
      },
      // log ยกเลิกตลาด/แผง ถอดแรงงาน และส่งยอดแทนของ TicketNo นี้ ใช้แสดงผู้ยกเลิกและ riskText
      adminActionLogs: {
        where: {
          actionType: {
            in: [
              ADMIN_ACTION_TYPE.MARKET_JOB_CANCELLED,
              ADMIN_ACTION_TYPE.STALL_JOB_CANCELLED,
              ADMIN_ACTION_TYPE.TICKET_WORKER_CANCELLED,
              ADMIN_ACTION_TYPE.TICKET_WORKER_CANCELLED_FROM_BOOTH,
              ADMIN_ACTION_TYPE.OVERRIDE_COUNT,
            ],
          },
        },
        include: {
          actor: true,
          actorGateClient: true,
        },
        orderBy: [
          {
            createdAt: "desc",
          },
          {
            id: "desc",
          },
        ],
      },
    },
  },
} satisfies Prisma.TicketWorkerInclude;

// Config ค่า cancelled_by_type ที่ใช้กรองแถว cancel ที่ไม่พบ log ยกเลิกจริง
export const DAILY_WORKER_INCOME_UNKNOWN_CANCELLER = "unknown";

// Function escape ตัวอักษรพิเศษของ ILIKE เพื่อให้ search เป็นการค้นหาแบบ contains ตรงตัว
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

// Function สร้าง CTE ของรายงานรายได้ worker รายวัน — คำนวณ payment_status/ผู้ยกเลิกใน SQL แล้วกรองทุก filter
// ก่อนแบ่งหน้า (เลือกได้ว่าจะรวม filter workerCode/shift หรือไม่ เพื่อทำ dropdown แบบ faceted)
function buildDailyWorkerIncomeCte(
  filters: DailyWorkerIncomeFilters,
  options: { includeWorkerCode: boolean; includeShift: boolean },
): Prisma.Sql {
  const scopedConditions: Prisma.Sql[] = [];

  // ใช้เวลาเสร็จงาน ถ้ายังไม่เสร็จใช้เวลาเข้าร่วม (แยกเป็นสองกิ่งเพื่อใช้ index ของแต่ละคอลัมน์ได้)
  if (filters.startAt || filters.endAt) {
    const completedRange: Prisma.Sql[] = [Prisma.sql`tw.completed_at IS NOT NULL`];
    const joinedRange: Prisma.Sql[] = [Prisma.sql`tw.completed_at IS NULL`];

    if (filters.startAt) {
      completedRange.push(Prisma.sql`tw.completed_at >= ${filters.startAt}`);
      joinedRange.push(Prisma.sql`tw.joined_at >= ${filters.startAt}`);
    }

    if (filters.endAt) {
      completedRange.push(Prisma.sql`tw.completed_at < ${filters.endAt}`);
      joinedRange.push(Prisma.sql`tw.joined_at < ${filters.endAt}`);
    }

    scopedConditions.push(
      Prisma.sql`((${Prisma.join(completedRange, " AND ")}) OR (${Prisma.join(joinedRange, " AND ")}))`,
    );
  }

  if (filters.search) {
    const pattern = `%${escapeLikePattern(filters.search)}%`;

    scopedConditions.push(Prisma.sql`(
      mj.ticket_no ILIKE ${pattern}
      OR tj.license_plate ILIKE ${pattern}
      OR mw.labor_code ILIKE ${pattern}
      OR mw.full_name ILIKE ${pattern}
      OR mw.coat_no ILIKE ${pattern}
    )`);
  }

  if (options.includeWorkerCode && filters.workerCode) {
    scopedConditions.push(Prisma.sql`LOWER(mw.labor_code) = LOWER(${filters.workerCode})`);
  }

  if (options.includeShift && filters.shift !== undefined) {
    scopedConditions.push(Prisma.sql`mw.shift_name = ${filters.shift}`);
  }

  const rowConditions: Prisma.Sql[] = [Prisma.sql`payment_status IS NOT NULL`];

  if (filters.paymentStatus) {
    rowConditions.push(Prisma.sql`payment_status = ${filters.paymentStatus}`);
  }

  // cancellation มีเฉพาะแถว cancel จึงกรองผู้ยกเลิกเฉพาะแถว cancel ("unknown" = ไม่พบ log ยกเลิกจริง)
  if (filters.cancelledByType) {
    rowConditions.push(Prisma.sql`payment_status = ${DAILY_WORKER_INCOME_PAYMENT_STATUS.CANCEL}`);
    rowConditions.push(
      filters.cancelledByType === DAILY_WORKER_INCOME_UNKNOWN_CANCELLER
        ? Prisma.sql`cancelled_by_type IS NULL`
        : Prisma.sql`LOWER(cancelled_by_type) = ${filters.cancelledByType}`,
    );
  }

  // ถูกถอดสิทธิ์รับเงินจากแผงที่ส่งยอดแล้วจนไม่เหลือเงิน = cancel (ใช้ทั้งใน CASE และตอนหา log ผู้ถอด)
  const removedWithoutPay = Prisma.sql`(
    mj.status = ${VEHICLE_JOB_STATUS.COMPLETED}
    AND removal.removed_from_submitted_booth
    AND COALESCE(tw.final_earning_amount, 0) = 0
  )`;

  return Prisma.sql`
    WITH scoped AS (
      SELECT
        tw.id,
        tw.worker_id,
        tw.final_earning_amount,
        mw.labor_code,
        mw.shift_name,
        assignment.accepted_at,
        removal.removed_from_submitted_booth,
        CASE
          WHEN mj.status = ${VEHICLE_JOB_STATUS.CANCELLED} THEN ${DAILY_WORKER_INCOME_PAYMENT_STATUS.CANCEL}::text
          -- ตลาดปิดยอดแล้วแต่ไม่มีชื่อในแผงใดเลย (เช่น roster sync ของแรงงานทดแทน) ไม่ใช่แถวรายได้
          WHEN mj.status = ${VEHICLE_JOB_STATUS.COMPLETED} AND NOT participation.has_booth_evidence THEN NULL
          WHEN ${removedWithoutPay} THEN ${DAILY_WORKER_INCOME_PAYMENT_STATUS.CANCEL}::text
          WHEN mj.status = ${VEHICLE_JOB_STATUS.COMPLETED} THEN
            CASE
              WHEN removal.removed_from_submitted_booth THEN ${DAILY_WORKER_INCOME_PAYMENT_STATUS.PARTIALLY_PAID}::text
              WHEN tw.status = ${TICKET_WORKER_STATUS.COMPLETED} THEN ${DAILY_WORKER_INCOME_PAYMENT_STATUS.SUCCESS}::text
              WHEN tw.status = ${TICKET_WORKER_STATUS.CANCELLED} AND tw.final_earning_amount > 0
                THEN ${DAILY_WORKER_INCOME_PAYMENT_STATUS.PARTIALLY_PAID}::text
            END
          -- reject ที่เจอหลัง release แปลว่าถูกตีกลับหลังปล่อยทีมแล้ว
          WHEN EXISTS (
            SELECT 1 FROM booth_jobs bj
            WHERE bj.market_job_id = mj.id AND bj.status = ${TICKET_STATUS.REJECT}
          ) THEN
            CASE
              WHEN assignment.released_at IS NOT NULL THEN ${DAILY_WORKER_INCOME_PAYMENT_STATUS.ADMIN_REJECT}::text
              ELSE ${DAILY_WORKER_INCOME_PAYMENT_STATUS.WORKER_REJECT}::text
            END
        END AS payment_status,
        COALESCE(cancel_log.id, removal_log.id) AS cancel_log_id,
        COALESCE(cancel_log.cancelled_by_type, removal_log.cancelled_by_type) AS cancelled_by_type
      FROM ticket_workers tw
      JOIN market_jobs mj ON mj.id = tw.market_job_id
      JOIN ticket_jobs tj ON tj.id = mj.ticket_job_id
      JOIN master_workers mw ON mw.id = tw.worker_id
      -- assignment ล่าสุดของ worker ในงานรถนี้ (ใช้ accepted_at เรียงลำดับ และ released_at ตัดสิน reject)
      LEFT JOIN LATERAL (
        SELECT tja.accepted_at, tja.released_at
        FROM ticket_job_assignments tja
        WHERE tja.ticket_job_id = tj.id AND tja.worker_id = tw.worker_id
        ORDER BY tja.created_at DESC, tja.id DESC
        LIMIT 1
      ) assignment ON TRUE
      -- log ยกเลิกจริงของ ticket_no: ยกเลิกทั้งรถก่อน ถ้าไม่มีใช้ log ยกเลิกตลาด/แผง ไม่พบเป็น null
      LEFT JOIN LATERAL (
        SELECT
          aal.id,
          COALESCE(account.role, CASE WHEN aal.actor_gate_client_id IS NOT NULL THEN 'gate' END) AS cancelled_by_type
        FROM (
          (
            SELECT id, actor_account_id, actor_gate_client_id, 0 AS priority, created_at
            FROM admin_action_logs
            WHERE ticket_job_id = tj.id AND action_type = ${ADMIN_ACTION_TYPE.VEHICLE_JOB_CANCELLED}
            ORDER BY created_at DESC, id DESC
            LIMIT 1
          )
          UNION ALL
          (
            SELECT id, actor_account_id, actor_gate_client_id, 1 AS priority, created_at
            FROM admin_action_logs
            WHERE market_job_id = mj.id
              AND action_type IN (${ADMIN_ACTION_TYPE.MARKET_JOB_CANCELLED}, ${ADMIN_ACTION_TYPE.STALL_JOB_CANCELLED})
            ORDER BY created_at DESC, id DESC
            LIMIT 1
          )
        ) aal
        LEFT JOIN accounts account ON account.id = aal.actor_account_id
        WHERE mj.status = ${VEHICLE_JOB_STATUS.CANCELLED}
        ORDER BY aal.priority
        LIMIT 1
      ) cancel_log ON TRUE
      -- ถูกถอดสิทธิ์รับเงินจากแผงที่ปิดยอดแล้ว หลังมีชื่อใน worker snapshot ของ submission แผงนั้น
      -- (นำกลับแล้ว exclusion ถูกลบ จึงสะท้อนสิทธิ์ปัจจุบัน)
      LEFT JOIN LATERAL (
        SELECT EXISTS (
          SELECT 1
          FROM booth_job_worker_exclusions exclusion
          JOIN booth_jobs bj ON bj.id = exclusion.booth_job_id
          WHERE exclusion.ticket_worker_id = tw.id
            AND bj.status = ${TICKET_STATUS.COMPLETED}
            AND EXISTS (
              SELECT 1
              FROM worker_snapshots ws
              JOIN ticket_completion_submissions submission ON submission.id = ws.submission_id
              WHERE submission.ticket_id = bj.id AND ws.ticket_worker_id = tw.id
            )
        ) AS removed_from_submitted_booth
      ) removal ON TRUE
      -- หลักฐานเข้าร่วมแผงของ MarketJob นี้: มีชื่อใน worker snapshot (confirm/submission) หรือมี payment
      LEFT JOIN LATERAL (
        SELECT (
          EXISTS (SELECT 1 FROM worker_snapshots ws WHERE ws.ticket_worker_id = tw.id)
          OR EXISTS (SELECT 1 FROM ticket_worker_payments twp WHERE twp.ticket_worker_id = tw.id)
        ) AS has_booth_evidence
      ) participation ON TRUE
      -- log ถอดแรงงานล่าสุดของ worker + ticket_no นี้ ใช้เป็นผู้ยกเลิกของแถว cancel จากการถอด
      LEFT JOIN LATERAL (
        SELECT
          aal.id,
          COALESCE(account.role, CASE WHEN aal.actor_gate_client_id IS NOT NULL THEN 'gate' END) AS cancelled_by_type
        FROM admin_action_logs aal
        LEFT JOIN accounts account ON account.id = aal.actor_account_id
        WHERE ${removedWithoutPay}
          AND aal.market_job_id = mj.id
          AND aal.action_type IN (
            ${ADMIN_ACTION_TYPE.TICKET_WORKER_CANCELLED},
            ${ADMIN_ACTION_TYPE.TICKET_WORKER_CANCELLED_FROM_BOOTH}
          )
          AND aal.metadata->>'worker_id' = tw.worker_id::text
        ORDER BY aal.created_at DESC, aal.id DESC
        LIMIT 1
      ) removal_log ON TRUE
      ${scopedConditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(scopedConditions, " AND ")}` : Prisma.empty}
    ),
    income_rows AS (
      SELECT * FROM scoped
      WHERE ${Prisma.join(rowConditions, " AND ")}
    )
  `;
}

// Function ดึงรายได้ worker รายวัน (หนึ่งแถว = TicketWorker หนึ่งคนใน Business Ticket หนึ่งใบ) กรอง เรียง
// และแบ่งหน้าที่ DB แล้วโหลดรายละเอียดเฉพาะแถวของหน้าปัจจุบัน
export async function listDailyWorkerIncome(
  filters: DailyWorkerIncomeFilters,
  connection?: DbConnection,
): Promise<DailyWorkerIncomeQueryResult> {
  const db = client(connection);
  const dataCte = buildDailyWorkerIncomeCte(filters, {
    includeWorkerCode: true,
    includeShift: true,
  });
  // ตัวเลือก workerCode/shift ไม่กรองตามกันเอง เพื่อให้เห็นตัวเลือกครบเสมอ
  const optionsCte = buildDailyWorkerIncomeCte(filters, {
    includeWorkerCode: false,
    includeShift: false,
  });
  // id เป็นตัวตัดสินเมื่อ accepted_at เท่ากัน เพื่อให้ลำดับคงที่ข้ามหน้า
  const orderBy =
    filters.sortOrder === "oldest"
      ? Prisma.sql`accepted_at ASC NULLS LAST, id ASC`
      : Prisma.sql`accepted_at DESC NULLS LAST, id DESC`;

  const [pageRows, summaryRows, optionRows] = await Promise.all([
    db.$queryRaw<
      Array<{
        id: number;
        payment_status: DailyWorkerIncomePaymentStatus;
        cancel_log_id: number | null;
        removed_from_submitted_booth: boolean;
      }>
    >(Prisma.sql`
      ${dataCte}
      SELECT id, payment_status, cancel_log_id, removed_from_submitted_booth
      FROM income_rows
      ORDER BY ${orderBy}
      LIMIT ${filters.limit} OFFSET ${(filters.page - 1) * filters.limit}
    `),
    db.$queryRaw<
      Array<{
        row_count: number;
        worker_count: number;
        payable_total: Prisma.Decimal;
        needs_review_count: number;
      }>
    >(Prisma.sql`
      ${dataCte}
      SELECT
        COUNT(*)::int AS row_count,
        COUNT(DISTINCT worker_id)::int AS worker_count,
        COALESCE(SUM(final_earning_amount) FILTER (
          WHERE payment_status IN (
            ${DAILY_WORKER_INCOME_PAYMENT_STATUS.SUCCESS},
            ${DAILY_WORKER_INCOME_PAYMENT_STATUS.PARTIALLY_PAID}
          )
        ), 0) AS payable_total,
        COUNT(*) FILTER (
          WHERE payment_status IN (
            ${DAILY_WORKER_INCOME_PAYMENT_STATUS.WORKER_REJECT},
            ${DAILY_WORKER_INCOME_PAYMENT_STATUS.ADMIN_REJECT}
          )
        )::int AS needs_review_count
      FROM income_rows
    `),
    db.$queryRaw<Array<{ worker_codes: string[] | null; shifts: string[] | null }>>(Prisma.sql`
      ${optionsCte}
      SELECT
        ARRAY_AGG(DISTINCT labor_code) AS worker_codes,
        ARRAY_AGG(DISTINCT shift_name) FILTER (WHERE shift_name IS NOT NULL) AS shifts
      FROM income_rows
    `),
  ]);

  const records =
    pageRows.length > 0
      ? await db.ticketWorker.findMany({
        where: {
          id: {
            in: pageRows.map((row) => row.id),
          },
        },
        include: DAILY_WORKER_INCOME_RECORD_INCLUDE,
      })
      : [];
  const recordById = new Map(records.map((record) => [record.id, record]));
  const summary = summaryRows[0] ?? {
    row_count: 0,
    worker_count: 0,
    payable_total: new Prisma.Decimal(0),
    needs_review_count: 0,
  };
  const options = optionRows[0] ?? { worker_codes: null, shifts: null };

  return {
    // คงลำดับตาม SQL (findMany ด้วย id IN ไม่รับประกันลำดับ)
    rows: pageRows.flatMap((row) => {
      const record = recordById.get(row.id);

      return record
        ? [{
          record,
          payment_status: row.payment_status,
          cancel_log_id: row.cancel_log_id,
          removed_from_submitted_booth: row.removed_from_submitted_booth,
        }]
        : [];
    }),
    summary: {
      ...summary,
      payable_total: new Prisma.Decimal(summary.payable_total),
    },
    available_worker_codes: [...(options.worker_codes ?? [])].sort(),
    available_shifts: [...(options.shifts ?? [])].sort(),
  };
}

/* -------------------------------------- Daily Stall Fee -------------------------------------- */

// Function แยก search เป็น token ด้วยช่องว่างหรือ comma (ต้อง match ทุก token)
function splitDailyStallFeeSearchTokens(search: string): string[] {
  return search
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

// Function สร้าง OR filter ของ search token บน TicketProductFinancial (เลขแผง/ทะเบียน/ตั๋ว/สินค้า)
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

// Function สร้าง OR filter ของ search token บน TicketProduct (ใช้หาตัวเลือกสินค้า/บรรจุภัณฑ์)
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

// Function สร้าง where ของ query หลักในรายงานค่าลงสินค้ารายวัน
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

// Function สร้าง where ของตัวเลือกสินค้า/บรรจุภัณฑ์แบบ faceted (ไม่กรองด้วยมิติของตัวเอง)
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

// Function ดึงรายงานค่าลงสินค้าแผงค้ารายวัน (หนึ่งแถว = TicketProductFinancial ที่ finalize แล้ว)
export async function listDailyStallFees(
  filters: DailyStallFeeFilters,
  connection?: DbConnection,
): Promise<DailyStallFeeQueryResult> {
  const db = client(connection);
  const where = buildDailyStallFeeWhere(filters, {
    includeProductCode: true,
    includePackageCode: true,
  });
  // ตัวเลือกสินค้ากรองตาม package_code และตัวเลือกบรรจุภัณฑ์กรองตาม product_code
  const productOptionsWhere = buildDailyStallFeeProductWhere(filters, {
    includeProductCode: false,
    includePackageCode: true,
  });
  const packageOptionsWhere = buildDailyStallFeeProductWhere(filters, {
    includeProductCode: true,
    includePackageCode: false,
  });

  const [data, aggregate, stallFeeAggregate, stallIdRows, productRows, packageRows] = await Promise.all([
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
      },
    }),
    // ยอดแผงเก็บที่ TicketProduct (คิดตอน Vendor ยืนยัน) จึงรวมจาก TicketProduct ที่ปิดยอดตามเงื่อนไขเดียวกัน
    db.ticketProduct.aggregate({
      where: {
        financial: {
          is: where,
        },
      },
      _sum: {
        stallFeeRounded: true,
      },
    }),
    // Prisma distinct บน relation ไม่ได้ จึงดึงเฉพาะ BoothJob id มานับแผงเอง
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
      stall_fee_total: stallFeeAggregate._sum.stallFeeRounded ?? new Prisma.Decimal(0),
    },
    available_products: availableProducts,
    available_packages: availablePackages,
  };
}

/* -------------------------------------- Monthly Stall Fee -------------------------------------- */

// Config FROM/JOIN ร่วมของ query รายงานค่าลงสินค้ารายเดือน
const MONTHLY_STALL_FEE_FROM = Prisma.sql`
  FROM ticket_product_financials tpf
  JOIN ticket_products tp ON tp.id = tpf.ticket_product_id
  JOIN booth_jobs gt ON gt.id = tp.ticket_id
  JOIN market_jobs mj ON mj.id = gt.market_job_id
`;

// Function สร้าง WHERE ของรายงานรายเดือน (เลือกได้ว่าจะรวม filter แต่ละตัวหรือไม่ เพื่อทำ faceted)
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
      Prisma.sql`tpf.shirt_color_snapshot = ${filters.shirtColor}`,
    );
  }

  return Prisma.join(conditions, " AND ");
}

// Config ป้ายสีเสื้อที่ต้องอยู่ท้าย dropdown เสมอ (สีจริงเรียงตามตัวอักษร)
const SHIRT_COLOR_TRAILING_ORDER = [
  SHIRT_COLOR_SNAPSHOT.MIXED,
  SHIRT_COLOR_SNAPSHOT.UNKNOWN,
] as const;

// Function ดึงรายงานค่าลงสินค้ารายเดือนด้วย raw SQL (GROUP BY ข้าม relation) รวมถึง facet และ pagination
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
          tpf.shirt_color_snapshot AS shirt_color,
          COUNT(*)::int AS financial_item_count,
          COALESCE(SUM(tp.stall_fee_rounded), 0) AS debit_amount
        ${MONTHLY_STALL_FEE_FROM}
        WHERE ${dataWhere}
        GROUP BY mj.market_code, gt.booth_code, tpf.shirt_color_snapshot
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
        COUNT(DISTINCT (mj.market_code, gt.booth_code, tpf.shirt_color_snapshot))::int AS row_count,
        COUNT(DISTINCT (mj.market_code, gt.booth_code))::int AS stall_count,
        COUNT(*)::int AS financial_item_count,
        COALESCE(SUM(tp.stall_fee_rounded), 0) AS debit_amount_total
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
      SELECT DISTINCT tpf.shirt_color_snapshot AS shirt_color
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
