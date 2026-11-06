// Import Library
import { Prisma } from "@prisma/client";
// Import Config
import { TICKET_JOB_ENTRY_MODE } from "../constants/status";
import { withTransaction } from "../db/prisma";
// Import Repositories
import * as adminManualJobsRepository from "../repositories/admin-manual-jobs.repository";
import * as gateRepository from "../repositories/gate.repository";
import * as adminActionLogRepository from "../repositories/shared/admin-action-log.repository";
// Import Services
import { prepareGateBooths, type PreparedGateBooths } from "./gate.service";
import { publishNotification } from "./notifications.service";
import * as ticketFinancialService from "./shared/ticket-financial.service";
// Import Types
import type { AdminManualJobDeleteResponse, AdminManualJobDetailResponse, AdminManualJobInput, AdminManualJobListItemResponse, AdminManualJobListRecord, AdminManualJobListResponse, AdminManualJobOverlapWarning, AdminManualJobProductResultResponse, AdminManualJobRecord, AdminManualJobResponse } from "../types/admin-jobs.type";
import type { AccessTokenPayload } from "../types/auth.type";
import type { DbConnection } from "../types/shared/common.type";
import { ADMIN_ACTION_TYPE } from "../types/shared/admin-action-log.type";
// Import Validation
import { parseRequiredReference, parseWithSchema } from "../validation/parser";
import { adminManualJobBodySchema, adminManualJobDeleteBodySchema, adminManualJobListQuerySchema } from "../validation/schemas";
// Import Utils
import { requireActorId } from "../utils/actor";
import { buildAdminEmployeeCode } from "../utils/admin-code";
import ApiError from "../utils/api-error";
import { setLogContext } from "../utils/log-context";
import { buildBangkokDateSpanRange, formatBangkokDate } from "../utils/time";

/* -------------------------------------- Types -------------------------------------- */

// Type ข้อมูลงานบันทึกย้อนหลังที่ตรวจกับ master data แล้ว (ตลาดเรียงตาม body)
type PreparedManualJob = {
  markets: Array<{
    market: AdminManualJobInput["markets"][number];
    prepared: PreparedGateBooths;
  }>;
  workerIdByCode: Map<string, number>;
};

// Type ชนิด event SSE ของงานบันทึกย้อนหลัง
type ManualJobEventType = "MANUAL_JOB_CREATED" | "MANUAL_JOB_UPDATED" | "MANUAL_JOB_DELETED";

/* -------------------------------------- Helpers -------------------------------------- */

// Function รวมเลข TicketNumber และ TicketNo ทุกตัวใน body (ใช้ lock เลขก่อนตรวจซ้ำ)
function collectManualTicketNumbers(input: AdminManualJobInput): string[] {
  return [input.ticket_number, ...input.markets.map((market) => market.ticket_no)];
}

// Function อ่าน TicketNumber จาก path
function parseManualTicketNumber(ticketNumberParam: unknown): string {
  return parseRequiredReference(ticketNumberParam, "INVALID_VEHICLE_JOB_REF", "TicketNumber is invalid.");
}

// Function ตรวจว่างานรถมีอยู่และเป็นงานบันทึกย้อนหลัง (งานจาก Gate แก้/ลบที่นี่ไม่ได้)
function requireManualJobRecord(record: AdminManualJobRecord | null): AdminManualJobRecord {
  if (!record) {
    throw new ApiError(404, "VEHICLE_JOB_NOT_FOUND", "Vehicle job not found.");
  }

  if (record.entryMode !== TICKET_JOB_ENTRY_MODE.MANUAL) {
    throw new ApiError(
      409,
      "VEHICLE_JOB_NOT_MANUAL_ENTRY",
      "Only manually entered vehicle jobs can be viewed, edited, or deleted with this API."
    );
  }

  return record;
}

// Function ตรวจตลาด แผง สินค้ากับ master data พร้อม Rate ปัจจุบัน และหา worker ทุกคน (ไม่ผ่าน throw 409)
async function prepareManualJob(
  input: AdminManualJobInput,
  connection: DbConnection
): Promise<PreparedManualJob> {
  const markets: PreparedManualJob["markets"] = [];

  for (const market of input.markets) {
    markets.push({
      market,
      prepared: await prepareGateBooths(
        {
          MarketCode: market.marketCode,
          Booths: market.booths.map((booth) => ({
            BoothCode: booth.boothCode,
            Products: booth.products.map((product) => ({
              ProductCode: product.productCode,
              PackageCode: product.packageCode,
              Quantity: product.quantity,
            })),
          })),
        },
        connection
      ),
    });
  }

  const workerCodes = [
    ...new Set(input.markets.flatMap((market) => market.booths.flatMap((booth) => booth.worker_codes))),
  ];
  const workers = await adminManualJobsRepository.listWorkersByLaborCodes(workerCodes, connection);
  const workerIdByCode = new Map(workers.map((worker) => [worker.laborCode, worker.id]));
  const missingWorkerCodes = workerCodes.filter((code) => !workerIdByCode.has(code));

  if (missingWorkerCodes.length > 0) {
    throw new ApiError(409, "WORKER_NOT_FOUND", "Some WorkerCodes were not found.", {
      worker_codes: missingWorkerCodes,
    });
  }

  return { markets, workerIdByCode };
}

// Function ตรวจว่าเลขตั๋วทุกตัวยังไม่ถูกใช้ (TicketNumber และ TicketNo ห้ามซ้ำกันเองทั้งระบบ รวมตั๋วที่ยกเลิกแล้ว)
async function assertManualTicketNumbersAvailable(
  input: AdminManualJobInput,
  ticketJobId: number | null,
  connection: DbConnection
): Promise<void> {
  if (await adminManualJobsRepository.isTicketNumberTaken(input.ticket_number, ticketJobId, connection)) {
    throw new ApiError(409, "TICKET_NUMBER_ALREADY_EXISTS", "TicketNumber already exists.", {
      ticketNumber: input.ticket_number,
    });
  }

  if (await adminManualJobsRepository.isTicketNoTaken(input.ticket_number, connection)) {
    throw new ApiError(
      409,
      "TICKET_NUMBER_CONFLICTS_WITH_TICKET_NO",
      "TicketNumber is already used as a TicketNo. TicketNumber and TicketNo must never share a number.",
      { ticketNumber: input.ticket_number }
    );
  }

  for (const market of input.markets) {
    if (await adminManualJobsRepository.isTicketNoTaken(market.ticket_no, connection)) {
      throw new ApiError(
        409,
        "TICKET_NO_ALREADY_EXISTS",
        "TicketNo was already issued to another ticket, including cancelled ones.",
        { ticketNo: market.ticket_no }
      );
    }

    if (await adminManualJobsRepository.isTicketNumberTaken(market.ticket_no, null, connection)) {
      throw new ApiError(
        409,
        "TICKET_NO_CONFLICTS_WITH_TICKET_NUMBER",
        "TicketNo is already used as a TicketNumber. TicketNumber and TicketNo must never share a number.",
        { ticketNo: market.ticket_no }
      );
    }
  }
}

// Function หา worker ที่มีงานอื่นช่วงเวลาทับกับงานนี้ (บันทึกได้ คืนเป็นคำเตือน)
async function listManualJobOverlapWarnings(
  input: AdminManualJobInput,
  workerIdByCode: Map<string, number>,
  ticketJobId: number,
  connection: DbConnection
): Promise<AdminManualJobOverlapWarning[]> {
  const overlaps = await adminManualJobsRepository.listOverlappingWorkedAssignments(
    [...workerIdByCode.values()],
    new Date(input.work_started_at),
    new Date(input.completed_at),
    ticketJobId,
    connection
  );

  return overlaps.map((overlap) => ({
    code: "WORKER_TIME_OVERLAP",
    worker_code: overlap.workerCode,
    ticket_number: overlap.ticketNumber,
    started_at: overlap.startedAt.toISOString(),
    ended_at: overlap.endedAt?.toISOString() ?? null,
  }));
}

// Function บันทึกตลาด แผง roster รอบส่งยอดที่ยืนยันแล้ว และปิดยอดเงินด้วยสูตรเดียวกับ flow ปกติ
async function saveManualJobChildren(
  ticketJobId: number,
  input: AdminManualJobInput,
  prepared: PreparedManualJob,
  actorId: number,
  connection: DbConnection
): Promise<void> {
  const workStartedAt = new Date(input.work_started_at);
  const completedAt = new Date(input.completed_at);
  const requireWorkerId = (code: string): number => prepared.workerIdByCode.get(code) as number;

  for (const { market, prepared: preparedMarket } of prepared.markets) {
    const marketJob = await adminManualJobsRepository.createManualMarketJob(
      {
        ticketJobId,
        ticketNo: market.ticket_no,
        boothCount: preparedMarket.booths.length,
        workersRequired: Math.max(1, preparedMarket.preparation.workerCount),
        marketCode: preparedMarket.preparation.market.marketCode,
        marketName: preparedMarket.preparation.market.marketName,
        dropoffPoint: market.dropoff_point,
        gateNo: input.gateNo ?? null,
        workStartedAt,
      },
      connection
    );
    const marketWorkerIds = [
      ...new Set(market.booths.flatMap((booth) => booth.worker_codes.map(requireWorkerId))),
    ];
    const ticketWorkerIdByWorkerId = await adminManualJobsRepository.createManualTicketWorkers(
      marketJob.id,
      marketWorkerIds,
      workStartedAt,
      connection
    );

    // prepareGateBooths คืนแผงเรียงตาม body จึงจับคู่ worker ของแผงด้วย index เดียวกัน
    for (const [index, booth] of preparedMarket.booths.entries()) {
      const boothJob = await adminManualJobsRepository.createManualBoothJob(
        {
          ticketJobId,
          marketJobId: marketJob.id,
          boothCode: booth.boothCode,
          boothName: booth.boothName,
          vendorLineId: booth.vendor_line_id ?? null,
          workStartedAt,
          completedAt,
        },
        connection
      );

      await gateRepository.createTicketProducts(boothJob.id, booth.products, connection);
      await adminManualJobsRepository.confirmManualBoothProductQuantities(boothJob.id, connection);
      await adminManualJobsRepository.createManualBoothSubmission(
        {
          boothJobId: boothJob.id,
          actorAccountId: actorId,
          ticketWorkerIds: market.booths[index].worker_codes.map(
            (code) => ticketWorkerIdByWorkerId.get(requireWorkerId(code)) as number
          ),
          completedAt,
        },
        connection
      );
      await ticketFinancialService.recordBoothStallCharges(boothJob.id, connection);
    }

    await ticketFinancialService.finalizeMarketJobFinancials(marketJob.id, connection, completedAt);
  }

  await adminManualJobsRepository.createManualAssignments(
    ticketJobId,
    [...prepared.workerIdByCode.values()],
    workStartedAt,
    completedAt,
    connection
  );
}

// Function บันทึกงานรถใหม่ หรือแทนข้อมูลทั้งหมดของงานรถเดิม แล้วคืน id และคำเตือนเวลาทับกัน (ผู้เรียกต้อง lock เลขตั๋วก่อน)
export async function saveManualJob(
  input: AdminManualJobInput,
  actorId: number,
  existingTicketJobId: number | null,
  connection: DbConnection
): Promise<{ ticketJobId: number; warnings: AdminManualJobOverlapWarning[] }> {
  const prepared = await prepareManualJob(input, connection);

  // แก้ไข = ลบข้อมูลเดิมใต้งานรถก่อน เลขตั๋วเดิมของงานนี้จึงใช้ซ้ำได้
  if (existingTicketJobId !== null) {
    await adminManualJobsRepository.deleteTicketJobChildren(existingTicketJobId, connection);
  }

  await assertManualTicketNumbersAvailable(input, existingTicketJobId, connection);

  const ticketJobData = {
    ticketNumber: input.ticket_number,
    licensePlate: input.license_plate,
    licensePlateProvince: input.license_plate_province,
    vehicleType: input.vehicleTypeName ?? null,
    vehicleTypeCode: input.vehicleTypeCode ?? null,
    // จำนวน worker ของงานรถ = ผลรวมของทุกตั๋ว (สูตรเดียวกับ Gate)
    workersRequired: prepared.markets.reduce(
      (sum, { prepared: market }) => sum + Math.max(1, market.preparation.workerCount),
      0
    ),
    workStartedAt: new Date(input.work_started_at),
    completedAt: new Date(input.completed_at),
  };
  let ticketJobId = existingTicketJobId;

  if (ticketJobId === null) {
    ticketJobId = (await adminManualJobsRepository.createManualTicketJob(ticketJobData, connection)).id;
  } else {
    await adminManualJobsRepository.updateManualTicketJob(ticketJobId, ticketJobData, connection);
  }

  const warnings = await listManualJobOverlapWarnings(input, prepared.workerIdByCode, ticketJobId, connection);

  await saveManualJobChildren(ticketJobId, input, prepared, actorId, connection);

  return { ticketJobId, warnings };
}

// Function แปลงงานบันทึกย้อนหลังเป็นข้อมูลรูปเดียวกับ body (ใช้เปิดฟอร์มแก้ไข และเก็บ before/after ใน log)
function buildManualJobDetail(record: AdminManualJobRecord): AdminManualJobDetailResponse {
  return {
    ticket_number: record.ticketNumber,
    license_plate: record.licensePlate,
    license_plate_province: record.licensePlateProvince,
    vehicle_type_code: record.vehicleTypeCode,
    vehicle_type_name: record.vehicleType,
    gate_no: record.marketJobs[0]?.gateNo ?? null,
    work_started_at: record.workStartedAt?.toISOString() ?? null,
    completed_at: record.completedAt?.toISOString() ?? null,
    markets: record.marketJobs.map((market) => ({
      ticket_no: market.ticketNo,
      marketCode: market.marketCode,
      marketName: market.marketName,
      dropoff_point: market.dropoffPoint,
      booths: market.tickets.map((booth) => ({
        boothCode: booth.boothCode,
        boothName: booth.boothName,
        worker_codes: booth.workerSnapshots.map((snapshot) => snapshot.ticketWorker.worker.laborCode),
        products: booth.products.map((product) => ({
          productCode: product.productCode,
          productName: product.productName,
          packageCode: product.packageCode,
          packageName: product.packageName,
          quantity: product.quantity.toNumber(),
        })),
      })),
    })),
    created_at: record.createdAt.toISOString(),
    updated_at: record.updatedAt.toISOString(),
  };
}

// Function แปลงยอดเงินที่ปิดยอดแล้วเป็น response ของงานบันทึกย้อนหลัง (ใช้ค่าจาก DB ไม่คำนวณซ้ำ)
function buildManualJobResponse(
  record: AdminManualJobRecord,
  result: AdminManualJobResponse["result"],
  message: string,
  warnings: AdminManualJobOverlapWarning[]
): AdminManualJobResponse {
  const zero = new Prisma.Decimal(0);
  const workerTotals = new Map<string, { full_name: string; total: Prisma.Decimal }>();
  let stallFeeTotal = zero;
  let workerPayoutTotal = zero;

  const markets = record.marketJobs.map((market) => {
    stallFeeTotal = stallFeeTotal.plus(market.finalStallAmount ?? zero);

    return {
      ticket_no: market.ticketNo,
      marketCode: market.marketCode,
      marketName: market.marketName,
      final_stall_amount: (market.finalStallAmount ?? zero).toFixed(2),
      booths: market.tickets.map((booth) => ({
        boothCode: booth.boothCode,
        boothName: booth.boothName,
        worker_codes: booth.workerSnapshots.map((snapshot) => snapshot.ticketWorker.worker.laborCode),
        final_stall_amount: (booth.finalStallAmount ?? zero).toFixed(2),
        products: booth.products.map((product): AdminManualJobProductResultResponse => {
          const payments = product.financial?.workerPayments ?? [];

          for (const payment of payments) {
            const { worker } = payment.ticketWorker;
            const current = workerTotals.get(worker.laborCode);

            workerTotals.set(worker.laborCode, {
              full_name: worker.fullName ?? worker.laborCode,
              total: (current?.total ?? zero).plus(payment.finalAmount),
            });
          }

          workerPayoutTotal = workerPayoutTotal.plus(product.financial?.workerPayoutTotal ?? zero);

          return {
            productCode: product.productCode,
            productName: product.productName,
            packageCode: product.packageCode,
            packageName: product.packageName,
            quantity: product.quantity.toFixed(2),
            stall_rate: (product.stallRateSnapshot ?? zero).toFixed(2),
            labor_rate: (product.laborRateSnapshot ?? zero).toFixed(2),
            stall_fee_rounded: (product.stallFeeRounded ?? zero).toFixed(2),
            labor_fee_raw: (product.laborFeeRaw ?? zero).toFixed(4),
            product_charge: (product.productCharge ?? zero).toFixed(2),
            worker_payout_total: (product.financial?.workerPayoutTotal ?? zero).toFixed(2),
            fund_amount: (product.financial?.fundAmount ?? zero).toFixed(4),
            amount_per_worker: (payments[0]?.finalAmount ?? zero).toFixed(2),
          };
        }),
      })),
    };
  });

  return {
    message,
    result,
    ticket_number: record.ticketNumber,
    work_started_at: record.workStartedAt?.toISOString() ?? null,
    completed_at: record.completedAt?.toISOString() ?? null,
    markets,
    workers: [...workerTotals].map(([workerCode, worker]) => ({
      worker_code: workerCode,
      full_name: worker.full_name,
      total_amount: worker.total.toFixed(2),
    })),
    stall_fee_total: stallFeeTotal.toFixed(2),
    worker_payout_total: workerPayoutTotal.toFixed(2),
    warnings,
  };
}

// Function แปลงงานบันทึกย้อนหลังเป็นแถวในหน้ารายการ (ยอดรวมจากที่ปิดยอดแล้ว)
function buildManualJobListItem(record: AdminManualJobListRecord): AdminManualJobListItemResponse {
  const zero = new Prisma.Decimal(0);
  const [lastLog] = record.adminActionLogs;
  const workerPayoutTotal = record.marketJobs
    .flatMap((market) => market.ticketWorkers)
    .reduce((sum, ticketWorker) => sum.plus(ticketWorker.finalEarningAmount ?? zero), zero);

  return {
    ticket_number: record.ticketNumber,
    ticket_nos: record.marketJobs.map((market) => market.ticketNo),
    license_plate: record.licensePlate,
    license_plate_province: record.licensePlateProvince,
    work_started_at: record.workStartedAt?.toISOString() ?? null,
    completed_at: record.completedAt?.toISOString() ?? null,
    market_count: record.marketJobs.length,
    booth_count: record.marketJobs.reduce((sum, market) => sum + market._count.tickets, 0),
    worker_count: record._count.assignments,
    stall_fee_total: record.marketJobs
      .reduce((sum, market) => sum.plus(market.finalStallAmount ?? zero), zero)
      .toFixed(2),
    worker_payout_total: workerPayoutTotal.toFixed(2),
    last_action: lastLog
      ? {
        action_type: lastLog.actionType,
        admin_code: lastLog.actorAccountId === null ? null : buildAdminEmployeeCode(lastLog.actorAccountId),
        full_name: lastLog.actor?.fullName ?? null,
        reason_code: lastLog.reasonCode,
        reason_text: lastLog.reasonText,
        created_at: lastLog.createdAt.toISOString(),
      }
      : null,
  };
}

// Function แจ้ง Admin ทุกคนผ่าน SSE ให้รีเฟรชข้อมูลงานบันทึกย้อนหลัง
function publishManualJobEvent(
  type: ManualJobEventType,
  message: string,
  payload: Record<string, unknown>
): void {
  publishNotification({
    type,
    title: "Manual vehicle job changed",
    message,
    payload: {
      ...payload,
      entry_mode: TICKET_JOB_ENTRY_MODE.MANUAL,
    },
    audience: {
      roles: ["admin"],
    },
  });
}

/* -------------------------------------- Functions -------------------------------------- */

// Function บันทึกงานรถย้อนหลังที่จบไปแล้ว (ไม่เรียก worker ไม่ส่ง LINE) และคิดเงินเหมือน flow ปกติ
export async function createManualJob(
  body: unknown,
  auth?: AccessTokenPayload
): Promise<AdminManualJobResponse> {
  const input = parseWithSchema(adminManualJobBodySchema, body);
  const actorId = requireActorId(auth);

  setLogContext({ ticketNumber: input.ticket_number, ticketNos: input.markets.map((market) => market.ticket_no) });

  const response = await withTransaction(async (transaction) => {
    await gateRepository.lockGateTicketNumbers(collectManualTicketNumbers(input), transaction);

    const { ticketJobId, warnings } = await saveManualJob(input, actorId, null, transaction);
    const record = requireManualJobRecord(
      await adminManualJobsRepository.findManualJobRecordById(ticketJobId, transaction)
    );

    await adminActionLogRepository.create(
      {
        vehicle_job_id: ticketJobId,
        action_type: ADMIN_ACTION_TYPE.MANUAL_JOB_CREATED,
        reason_code: input.reason_code,
        reason_text: input.reason_text,
        actor_account_id: actorId,
        metadata: {
          ticket_number: input.ticket_number,
          after: buildManualJobDetail(record),
          warnings,
        },
      },
      transaction
    );

    return buildManualJobResponse(record, "CREATED", "Manual vehicle job saved.", warnings);
  });

  publishManualJobEvent("MANUAL_JOB_CREATED", `Manual vehicle job ${response.ticket_number} was saved by admin.`, {
    ticketNumber: response.ticket_number,
    ticketNos: response.markets.map((market) => market.ticket_no),
  });

  return response;
}

// Function ดึงรายการงานบันทึกย้อนหลังตามวันที่ทำงาน (ไม่ส่งวันที่ = วันปัจจุบัน, page/limit default 1/20)
export async function listManualJobs(query: unknown): Promise<AdminManualJobListResponse> {
  const input = parseWithSchema(adminManualJobListQuerySchema, query);
  const today = formatBangkokDate();
  const dateFrom = input.date_from ?? today;
  const dateTo = input.date_to ?? today;

  // ส่งมาแค่วันเดียวแล้วอีกฝั่งเป็นวันนี้ อาจได้ช่วงกลับด้าน (เช่น date_from ในอนาคต)
  if (dateFrom > dateTo) {
    throw new ApiError(400, "VALIDATION_ERROR", "date_from must not be after date_to.", {
      validation_errors: [{ field: "date_from", message: "date_from must not be after date_to." }],
    });
  }

  const range = buildBangkokDateSpanRange(dateFrom, dateTo);
  const { records, total } = await adminManualJobsRepository.listManualJobs({
    startAt: range.startAt as Date,
    endAt: range.endAt as Date,
    search: input.search,
    page: input.page,
    limit: input.limit,
  });

  return {
    date_from: dateFrom,
    date_to: dateTo,
    data: records.map(buildManualJobListItem),
    pagination: {
      page: input.page,
      limit: input.limit,
      total,
      total_pages: Math.ceil(total / input.limit),
    },
  };
}

// Function ดึงงานบันทึกย้อนหลังในรูปเดียวกับ body สำหรับเปิดฟอร์มแก้ไข
export async function getManualJob(ticketNumberParam: unknown): Promise<AdminManualJobDetailResponse> {
  const ticketNumber = parseManualTicketNumber(ticketNumberParam);

  return buildManualJobDetail(
    requireManualJobRecord(await adminManualJobsRepository.findManualJobRecordByRef(ticketNumber))
  );
}

// Function แก้ไขงานบันทึกย้อนหลังที่กรอกผิด (แทนข้อมูลทั้งงานด้วย body ใหม่ และคิดเงินใหม่ด้วย Rate ปัจจุบัน)
export async function updateManualJob(
  ticketNumberParam: unknown,
  body: unknown,
  auth?: AccessTokenPayload
): Promise<AdminManualJobResponse> {
  const ticketNumber = parseManualTicketNumber(ticketNumberParam);
  const input = parseWithSchema(adminManualJobBodySchema, body);
  const actorId = requireActorId(auth);

  setLogContext({ ticketNumber, ticketNos: input.markets.map((market) => market.ticket_no) });

  const response = await withTransaction(async (transaction) => {
    // lock เลขก่อนแถวงานรถเสมอ (ลำดับเดียวกับ Gate) กัน deadlock
    await gateRepository.lockGateTicketNumbers([ticketNumber, ...collectManualTicketNumbers(input)], transaction);

    const current = requireManualJobRecord(
      await adminManualJobsRepository.lockAndFindManualJobRecordByRef(ticketNumber, transaction)
    );
    const before = buildManualJobDetail(current);
    const { warnings } = await saveManualJob(input, actorId, current.id, transaction);
    const record = requireManualJobRecord(
      await adminManualJobsRepository.findManualJobRecordById(current.id, transaction)
    );

    await adminActionLogRepository.create(
      {
        vehicle_job_id: current.id,
        action_type: ADMIN_ACTION_TYPE.MANUAL_JOB_UPDATED,
        reason_code: input.reason_code,
        reason_text: input.reason_text,
        actor_account_id: actorId,
        metadata: {
          ticket_number: input.ticket_number,
          previous_ticket_number: ticketNumber,
          before,
          after: buildManualJobDetail(record),
          warnings,
        },
      },
      transaction
    );

    return buildManualJobResponse(record, "UPDATED", "Manual vehicle job updated.", warnings);
  });

  publishManualJobEvent("MANUAL_JOB_UPDATED", `Manual vehicle job ${response.ticket_number} was updated by admin.`, {
    ticketNumber: response.ticket_number,
    previousTicketNumber: ticketNumber,
    ticketNos: response.markets.map((market) => market.ticket_no),
  });

  return response;
}

// Function ลบงานบันทึกย้อนหลังที่กรอกผิดหรือกรอกเกิน (ลบออกจากประวัติ/รายงานทั้งหมด คง log ของ Admin พร้อมข้อมูลก่อนลบ)
export async function deleteManualJob(
  ticketNumberParam: unknown,
  body: unknown,
  auth?: AccessTokenPayload
): Promise<AdminManualJobDeleteResponse> {
  const ticketNumber = parseManualTicketNumber(ticketNumberParam);
  const input = parseWithSchema(adminManualJobDeleteBodySchema, body);
  const actorId = requireActorId(auth);

  setLogContext({ ticketNumber });

  const before = await withTransaction(async (transaction) => {
    await gateRepository.lockGateTicketNumbers([ticketNumber], transaction);

    const current = requireManualJobRecord(
      await adminManualJobsRepository.lockAndFindManualJobRecordByRef(ticketNumber, transaction)
    );
    const detail = buildManualJobDetail(current);

    await adminManualJobsRepository.deleteTicketJobChildren(current.id, transaction);
    await adminManualJobsRepository.deleteTicketJob(current.id, transaction);
    await adminActionLogRepository.create(
      {
        vehicle_job_id: null,
        action_type: ADMIN_ACTION_TYPE.MANUAL_JOB_DELETED,
        reason_code: input.reason_code,
        reason_text: input.reason_text,
        actor_account_id: actorId,
        metadata: {
          ticket_number: ticketNumber,
          before: detail,
        },
      },
      transaction
    );

    return detail;
  });

  publishManualJobEvent("MANUAL_JOB_DELETED", `Manual vehicle job ${ticketNumber} was deleted by admin.`, {
    ticketNumber,
    ticketNos: before.markets.map((market) => market.ticket_no),
  });

  return {
    message: "Manual vehicle job deleted.",
    ticket_number: ticketNumber,
    reason_code: input.reason_code,
    reason_text: input.reason_text,
  };
}
