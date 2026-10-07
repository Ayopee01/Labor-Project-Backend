// Import Library
import { createHash, randomUUID } from "crypto";
import { Prisma, type MasterMarket } from "@prisma/client";
// Import Config
import { SCANNED_ASSIGNMENT_STATUSES, TERMINAL_JOB_STATUSES, TICKET_STATUS, VEHICLE_JOB_STATUS } from "../constants/status";
import { getDriverWebBaseUrl } from "../config/driver.config";
import { withTransaction } from "../db/prisma";
// Import Repositories
import * as gateRepository from "../repositories/gate.repository";
import * as adminActionLogRepository from "../repositories/shared/admin-action-log.repository";
import * as assignmentRepository from "../repositories/shared/ticket-job-assignment.repository";
import * as marketJobRepository from "../repositories/shared/market-job.repository";
import * as profileRepository from "../repositories/shared/profile.repository";
import * as ticketJobRepository from "../repositories/shared/ticket-job.repository";
// Import Services
import { publishDriverJobUpdate } from "./driver-stream.service";
import { publishAdminWorkerStatusChanged, publishNotification } from "./notifications.service";
import { publishRealtimeEvent } from "./shared/realtime-notification.service";
import * as rateResolutionService from "./shared/rate-resolution.service";
import { handleTicketJobClosedByCascadeCancellation } from "./shared/ticket-job-closure.service";
import * as ticketJobLifecycleService from "./shared/ticket-job-lifecycle.service";
import { notifyVendorBoothCancelled } from "./shared/vendor-line-notification.service";
import { notifyTicketJobTeamScanReadiness } from "./worker.service";
// Import Queues
import { enqueueLoggedLineMessage } from "../queues/line-message-queue";
import { dispatchReadyWorkers, requeueWorkersAtFrontRespectingShift } from "../queues/worker-dispatch";
import { getWorkerQueueStatus, removeAssignmentTimeout, removeScanTimeout, removeScanWarning } from "../queues/worker-queue";
// Import Websockets
import { sendWorkerSocketEvent } from "../websockets/worker.socket";
// Import Types
import type { BoothJobJobBody, BoothJobJobBoothBody, BoothJobJobCreateInput, BoothJobJobResponse, BoothJobJobResponseBooth, BoothJobJobResponseMarket, BoothJobJobResponseStatus, BoothJobJobResult, GateBoothCreateInput, GateMarketCreateInput, GateOptionsResponse, GateProductOption, GateTicketBoothRecord, GateTicketChangeSummary, GateTicketDetailResponse, GateRequestReplayRecord, GateTicketLockReason, GateTicketRevisionSnapshot, GateTicketUpdateBody, GateTicketUpdateResponse } from "../types/gate.type";
import type { DbConnection } from "../types/shared/common.type";
import type { PublicGateClient } from "../types/shared/gate-client.type";
import type { LineMessage } from "../types/line.type";
import type { CompletedTicketJobResult, MarketJobDto, TicketJobAssignmentDto, TicketJobDto, VehicleWorkReadinessDto, VendorLineTargetDto } from "../types/worker.type";
import { ADMIN_ACTION_TYPE, GATE_TICKET_UPDATE_REASON_CODE } from "../types/shared/admin-action-log.type";
import { WORKER_WORK_STATUS } from "../types/shared/worker-status.type";
// Import Validation
import { parseWithSchema } from "../validation/parser";
import { boothJobJobBodySchema, gateTicketNoSchema, gateTicketUpdateBodySchema } from "../validation/schemas";
// Import Utils
import { setLogContext } from "../utils/log-context";
import ApiError from "../utils/api-error";
import { buildGateTicketChangeDetails } from "../utils/gate-ticket-change-details";
import { calculateRequiredWorkerCount, packageWeightToDecimal, parseMasterProductRange } from "../utils/labor-job-pricing";
import { logger } from "../utils/logger";
import { buildBoothJobCreatedFlexMessage, buildBoothJobUpdatedFlexMessage } from "../utils/line-flex-message";
import { resolveEffectiveWorkersRequired } from "../utils/team-requirement";
import { buildWorkerQueueSocketPayload } from "../utils/worker-payload";

/* -------------------------------------- Types -------------------------------------- */

// Type ข้อมูลสินค้าที่เตรียมแล้วพร้อม rate snapshot
type LaborProductPreparation = {
  product: {
    id: number;

    productCode: string;
    productFullCode: string;
    productName: string;

    packageCode: string;
    packageName: string;

    quantity: number;
  };

  // จำนวน Worker จาก Master ใช้สำหรับ Dispatch เท่านั้น
  requiredWorkerCount: number;

  // Rate snapshot ณ ตอน Gate Create
  rateSnapshot: {
    rateId: number;
    sourceRateId: number;

    requestedMarketCode: string;
    appliedMarketCode: string;

    rateSource:
    | "MARKET_RATE"
    | "CENTRAL_RATE";

    packageWeight: Prisma.Decimal;

    weightRangeName: string;
    weightMin: Prisma.Decimal;
    weightMax: Prisma.Decimal;

    stallRate: Prisma.Decimal;
    laborRate: Prisma.Decimal;

    snapshotAt: Date;
  };
};

// Type ข้อมูลแผงที่เตรียมแล้วพร้อมสินค้า
type LaborBoothPreparation = {
  boothCode: string;
  boothName: string;

  products: LaborProductPreparation[];
};

// Type ข้อมูลตั๋ว 1 ตลาดที่เตรียมแล้วพร้อมแผง และจำนวน worker
type LaborJobPreparation = {
  market: {
    marketCode: string;
    marketName: string;
  };

  booths: LaborBoothPreparation[];

  // จำนวน Worker สำหรับ Dispatch
  workerCount: number;
};

// Type แผงที่เตรียมบันทึกแล้วพร้อม LINE target ของ Vendor
type PreparedGateBooths = {
  preparation: LaborJobPreparation;
  booths: GateBoothCreateInput[];
  vendorLineTargetsByBoothCode: Map<string, VendorLineTargetDto[]>;
};

// Type ผลเทียบแผงเดิมกับแผงที่ Gate ส่งมาแก้ไข (updated = แก้ในแถวเดิม ไม่ยกเลิก)
type GateBoothChangePlan = {
  added: BoothJobJobBoothBody[];
  removed: GateTicketBoothRecord[];
  updated: Array<{ current: GateTicketBoothRecord; next: BoothJobJobBoothBody }>;
  unchanged: GateTicketBoothRecord[];
};

// Type แผงที่ถูกนำออกระหว่างแก้ไข (ใช้แจ้ง LINE ยกเลิกหลัง commit)
type CancelledGateBooth = {
  id: number;
  boothCode: string;
  boothName: string | null;
};

/* -------------------------------------- Config -------------------------------------- */

// Config status ที่คืนให้ Gate เท่านั้น แยกจาก VEHICLE_OPERATION_STATUS ของ Admin Ops Board โดยตั้งใจ
const GATE_TICKET_RESPONSE_STATUS = {
  UNLOAD_NOW: "unload_now",
  WAITING_UNLOAD: "waiting_unload",
} as const;

/* -------------------------------------- Shared Helpers -------------------------------------- */

// Function สร้าง status ที่คืนให้ Gate
function buildBoothJobResponseStatus(
  dispatch: boolean
): BoothJobJobResponseStatus {
  return dispatch
    ? GATE_TICKET_RESPONSE_STATUS.UNLOAD_NOW
    : GATE_TICKET_RESPONSE_STATUS.WAITING_UNLOAD;
}

// Function ตรวจ Gate body สำหรับ replay
function isBoothJobJobBody(
  value: unknown
): value is BoothJobJobBody {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record.TicketNumber === "string" &&
    Array.isArray(record.Markets) &&
    typeof record.Dispatch === "boolean"
  );
}

// Function หา Market + Booth จาก master
async function requireActiveMasterMarketBooth(
  marketCode: string,
  boothCode: string,
  connection?: DbConnection
): Promise<MasterMarket> {
  const marketBooth =
    await gateRepository.findActiveMarketBoothByCodes(
      marketCode,
      boothCode,
      connection
    );

  if (!marketBooth) {
    throw new ApiError(
      409,
      "MARKET_BOOTH_NOT_FOUND",
      "Active MarketCode + BoothCode mapping was not found in master_market.",
      {
        marketCode,
        boothCode,
      }
    );
  }

  if (!marketBooth.marketName) {
    throw new ApiError(
      409,
      "MARKET_NAME_NOT_CONFIGURED",
      "Master market name is not configured.",
      {
        marketCode,
        boothCode,
      }
    );
  }

  return marketBooth;
}

// Function ตรวจตลาด แผง และสินค้ากับ master data พร้อมหาจำนวน worker และ rate snapshot ของตั๋ว 1 ตลาด
async function prepareLaborJob(
  input: {
    MarketCode: string;
    Booths: BoothJobJobBoothBody[];
  },
  connection?: DbConnection
): Promise<LaborJobPreparation> {
  const booths: LaborBoothPreparation[] = [];
  const workerCounts: number[] = [];

  let marketName = "";

  // ให้ Product ทุกตัวใน request เดียวกันใช้เวลา snapshot เดียวกัน
  const rateSnapshotAt = new Date();

  for (const boothInput of input.Booths) {
    const marketBooth =
      await requireActiveMasterMarketBooth(
        input.MarketCode,
        boothInput.BoothCode,
        connection
      );

    if (!marketName) {
      marketName =
        marketBooth.marketName as string;
    }

    const products:
      LaborProductPreparation[] = [];

    for (
      const productInput
      of boothInput.Products
    ) {
      const product =
        await rateResolutionService.requireActiveMasterProduct(
          productInput.ProductCode,
          productInput.PackageCode,
          connection
        );

      const parsedRange =
        parseMasterProductRange(
          product.range
        );

      // Gate Quantity ใช้ตรงนี้เท่านั้น เพื่อหา Worker ที่ต้องเรียก
      const workerRequirement =
        calculateRequiredWorkerCount(
          productInput.Quantity,
          parsedRange.workerRanges
        );

      workerCounts.push(
        workerRequirement.requiredWorkerCount
      );

      const packageWeight =
        packageWeightToDecimal(
          product.packageWeight
        );

      // หา Rate ที่ใช้ ณ ตอนสร้างงาน
      const applicableRate =
        await rateResolutionService.requireApplicableRate(
          input.MarketCode,
          packageWeight,
          connection
        );

      products.push({
        product: {
          id: product.id,
          productCode: product.productCode,
          productFullCode: product.productFullCode,
          productName: product.productName,
          packageCode: product.packageCode,
          packageName: product.packageName,
          quantity: productInput.Quantity,
        },

        requiredWorkerCount: workerRequirement.requiredWorkerCount,

        rateSnapshot: {
          rateId: applicableRate.rate.id,
          sourceRateId: applicableRate.rate.sourceRateId,
          requestedMarketCode: applicableRate.requestedMarketCode,
          appliedMarketCode: applicableRate.appliedMarketCode,
          rateSource: applicableRate.rateSource,
          packageWeight,
          weightRangeName: applicableRate.rate.weightRangeName,
          weightMin: applicableRate.rate.weightMin,
          weightMax: applicableRate.rate.weightMax,
          stallRate: applicableRate.rate.stallRate,
          laborRate: applicableRate.rate.laborRate,
          snapshotAt: rateSnapshotAt,
        },
      });
    }

    booths.push({
      boothCode: marketBooth.boothCode,
      boothName: marketBooth.boothName,
      products,
    });
  }

  if (workerCounts.length === 0) {
    throw new ApiError(
      409,
      "WORKER_REQUIREMENT_NOT_FOUND",
      "No worker requirement was calculated."
    );
  }

  return {
    market: {
      marketCode: input.MarketCode,
      marketName,
    },

    booths,

    // จำนวน worker ของตั๋ว = ค่าสูงสุดของทุกสินค้าในทุกแผง (ไม่ใช่ผลรวม)
    workerCount: Math.max(...workerCounts),
  };
}

// Function แปลงแผงที่เตรียมแล้วเป็นข้อมูลก่อนบันทึก (rate snapshot เป็น string ตาม Decimal)
function buildGateBoothCreateInputs(
  preparation: LaborJobPreparation
): GateBoothCreateInput[] {
  return preparation.booths.map((booth) => ({
    boothCode: booth.boothCode,
    boothName: booth.boothName,
    products: booth.products.map((item) => ({
      productCode: item.product.productCode,
      productName: item.product.productName,
      productFullCode: item.product.productFullCode,
      packageCode: item.product.packageCode,
      packageName: item.product.packageName,
      quantity: item.product.quantity,
      requiredWorkerCount: item.requiredWorkerCount,
      packageWeightSnapshot: item.rateSnapshot.packageWeight.toString(),
      rateIdSnapshot: item.rateSnapshot.rateId,
      sourceRateIdSnapshot: item.rateSnapshot.sourceRateId,
      rateMarketCode: item.rateSnapshot.appliedMarketCode,
      rateSource: item.rateSnapshot.rateSource,
      weightRangeName: item.rateSnapshot.weightRangeName,
      weightMinSnapshot: item.rateSnapshot.weightMin.toString(),
      weightMaxSnapshot: item.rateSnapshot.weightMax.toString(),
      stallRateSnapshot: item.rateSnapshot.stallRate.toString(),
      laborRateSnapshot: item.rateSnapshot.laborRate.toString(),
      rateSnapshotAt: item.rateSnapshot.snapshotAt,
    })),
  }));
}

// Function เตรียมแผงใหม่ของตั๋ว 1 ตลาด พร้อมเติม Vendor LINE ID (แผงไม่มี LINE จะ throw)
async function prepareGateBooths(
  input: {
    MarketCode: string;
    Booths: BoothJobJobBoothBody[];
  },
  connection?: DbConnection
): Promise<PreparedGateBooths> {
  const preparation = await prepareLaborJob(input, connection);
  const vendorLineTargetsByBoothCode = new Map<string, VendorLineTargetDto[]>();
  const booths: GateBoothCreateInput[] = [];

  for (const booth of buildGateBoothCreateInputs(preparation)) {
    const vendorLineTargets =
      await gateRepository.listActiveVendorLineTargetsByStall(
        input.MarketCode,
        booth.boothCode,
        connection
      );

    if (vendorLineTargets.length === 0) {
      throw new ApiError(
        409,
        "BOOTH_VENDOR_LINE_NOT_CONFIGURED",
        "Booth vendor LINE id is not configured in vendor master mapping.",
        {
          marketCode: input.MarketCode,
          boothCode: booth.boothCode,
        }
      );
    }

    vendorLineTargetsByBoothCode.set(booth.boothCode, vendorLineTargets);
    booths.push({
      ...booth,
      vendor_line_id: vendorLineTargets[0].line_user_id,
    });
  }

  return {
    preparation,
    booths,
    vendorLineTargetsByBoothCode,
  };
}

// Function สร้าง URL หน้า Driver Web โดยใส่ token ใน fragment (#token=) เพื่อไม่ให้ token ไปอยู่ใน log
function buildDriverQrUrl(driverQrToken: string): string {
  return `${getDriverWebBaseUrl()}/track#token=${encodeURIComponent(driverQrToken)}`;
}

// Function แปลงแผงที่บันทึกแล้วเป็น response ของ Gate
function buildBoothResponseFromRecord(
  booth: GateTicketBoothRecord
): BoothJobJobResponseBooth {
  return {
    BoothCode: booth.booth_code,
    BoothName: booth.booth_name,
    Products: booth.products.map((product) => ({
      ProductCode: product.product_code,
      ProductFullCode: product.product_full_code,
      ProductName: product.product_name,
      PackageCode: product.package_code,
      PackageName: product.package_name,
      Quantity: product.quantity,
      // Master requirement ไม่ใช่จำนวนสำหรับหารเงินจริง
      WorkerCount: product.required_worker_count,
    })),
  };
}

// Function แปลงแผงที่เตรียมแล้วเป็น response ของ Gate
function buildBoothResponseFromPreparation(
  booth: LaborBoothPreparation
): BoothJobJobResponseBooth {
  return {
    BoothCode: booth.boothCode,
    BoothName: booth.boothName,
    Products: booth.products.map((item) => ({
      ProductCode: item.product.productCode,
      ProductFullCode: item.product.productFullCode,
      ProductName: item.product.productName,
      PackageCode: item.product.packageCode,
      PackageName: item.product.packageName,
      Quantity: item.product.quantity,
      WorkerCount: item.requiredWorkerCount,
    })),
  };
}

// Function สร้างข้อมูลตั๋ว 1 ใบที่คืนให้ Gate
function buildMarketResponse(
  marketJob: MarketJobDto,
  booths: BoothJobJobResponseBooth[]
): BoothJobJobResponseMarket {
  return {
    TicketNo: marketJob.ticket_no,
    TicketCreatedAt: marketJob.ticket_created_at,
    MarketCode: marketJob.marketCode,
    MarketName: marketJob.marketName,
    DropoffPoint: marketJob.dropoff_point,
    BoothCount: marketJob.booth_count,
    WorkerCount: marketJob.workers_required,
    Booths: booths,
  };
}

// Function สร้าง response ที่คืนให้ Gate — เป็นข้อมูล Operation เท่านั้น ยังไม่มีเงินจริง
function buildPublicBoothJobJobResponse(
  ticketJob: TicketJobDto,
  markets: BoothJobJobResponseMarket[],
  gateNo: string,
  dispatch: boolean,
  result: BoothJobJobResult
): BoothJobJobResponse {
  return {
    Result: result,
    TicketNumber: ticketJob.ticket_number,
    GateNo: gateNo,

    Vehicle: {
      LicensePlate: ticketJob.license_plate,
      LicensePlateProvince: ticketJob.license_plate_province,
      VehicleTypeCode: ticketJob.vehicle_type_code,
      VehicleTypeName: ticketJob.vehicle_type,
      Status: buildBoothJobResponseStatus(dispatch),
    },

    Markets: markets,

    // จำนวน Worker รวมทุกตั๋วของ TicketNumber นี้ที่ใช้ Dispatch
    WorkerCount: ticketJob.workers_required,

    Qr: {
      DriverQrToken: ticketJob.driver_qr_token,
      DriverQrUrl: buildDriverQrUrl(ticketJob.driver_qr_token),
    },
  };
}

// Function แจ้ง LINE Vendor ของแต่ละแผงในตั๋วว่ามีงานลงสินค้า (created) หรือรายการสินค้าถูกแก้ไข (updated)
async function notifyVendorBoothJobCreated(
  response: BoothJobJobResponse,
  market: BoothJobJobResponseMarket,
  booths: BoothJobJobResponseBooth[],
  vendorLineTargetsByBoothCode: Map<string, VendorLineTargetDto[]>,
  kind: "created" | "updated" = "created"
): Promise<void> {
  for (const booth of booths) {
    const vendorLineTargets =
      vendorLineTargetsByBoothCode.get(booth.BoothCode) ?? [];

    if (vendorLineTargets.length === 0) {
      continue;
    }

    const ticket = {
      ticketNo: market.TicketNo,
      marketName: market.MarketName,
      licensePlate: response.Vehicle.LicensePlate,
    };
    const messages: LineMessage[] = [
      kind === "updated"
        ? buildBoothJobUpdatedFlexMessage(ticket, booth)
        : buildBoothJobCreatedFlexMessage(ticket, booth),
    ];

    for (const target of vendorLineTargets) {
      await enqueueLoggedLineMessage({
        jobName: `send-gate-ticket-${kind}`,
        action: `send_gate_ticket_${kind}`,
        targetLineUserId: target.line_user_id,
        payload: {
          ticketNumber: response.TicketNumber,
          ticketNo: market.TicketNo,
          marketCode: market.MarketCode,
          boothCode: booth.BoothCode,
          productCode: booth.Products[0]?.ProductCode ?? "",
          vendor_line_id: target.line_user_id,
          vendor_line_target_type: target.target_type,
          status: response.Vehicle.Status,
        },
        messages,
      });
    }
  }
}

// Function จัดรูปแบบ JSON ก่อน compare
function normalizeJson(
  value: unknown
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) =>
      normalizeJson(item)
    );
  }

  if (
    !value ||
    typeof value !== "object"
  ) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(
      value as Record<string, unknown>
    )
      .filter(
        ([, entryValue]) =>
          entryValue !== undefined
      )
      .sort(
        ([leftKey], [rightKey]) =>
          leftKey.localeCompare(rightKey)
      )
      .map(
        ([key, entryValue]) => [
          key,
          normalizeJson(entryValue),
        ]
      )
  );
}

// Function เปรียบเทียบ payload
function arePayloadsEqual(
  left: unknown,
  right: unknown
): boolean {
  return (
    JSON.stringify(normalizeJson(left)) ===
    JSON.stringify(normalizeJson(right))
  );
}

// Function สร้าง transaction ref ของ Gate สำหรับ idempotency (ใช้ IdempotencyKey ถ้ามี ไม่งั้น hash ทั้ง body)
function buildGateTransactionRef(
  input: BoothJobJobBody
): string {
  const hashInput = input.IdempotencyKey
    ? `IDEMPOTENCY_KEY:${input.IdempotencyKey}`
    : JSON.stringify(normalizeJson(input));

  const hash =
    createHash("sha256")
      .update(hashInput)
      .digest("hex")
      .slice(0, 24);

  return `GATE-${hash}`;
}

/* -------------------------------------- Gate Create -------------------------------------- */

// Function สร้างข้อมูลตั๋ว 1 ตลาดก่อนบันทึก
function buildGateMarketCreateInput(
  market: BoothJobJobBody["Markets"][number],
  gateTransactionRef: string,
  prepared: PreparedGateBooths
): GateMarketCreateInput {
  return {
    ticketNo: market.TicketNo,
    ticket_created_at: new Date(market.TicketCreatedAt),
    booth_count: prepared.booths.length,
    gate_transaction_ref: gateTransactionRef,
    workers_required: prepared.preparation.workerCount,
    marketCode: prepared.preparation.market.marketCode,
    marketName: prepared.preparation.market.marketName,
    dropoff_point: market.DropoffPoint,
    booths: prepared.booths,
  };
}

// Function sync roster และเปิดแผงถัดไปเมื่อทีมของรถสแกนครบและทำงานอยู่แล้ว (ตั๋วใหม่ได้ roster ทันที)
async function syncWorkingTeamAfterGateChange(
  ticketJob: TicketJobDto,
  connection?: DbConnection
): Promise<VehicleWorkReadinessDto> {
  const teamScan = await assignmentRepository.getTicketJobTeamScanReadiness(
    ticketJob.id,
    connection
  );

  if (teamScan.is_ready && ticketJob.status === VEHICLE_JOB_STATUS.WORKING) {
    await ticketJobLifecycleService.markTicketJobInProgress(ticketJob.id, connection);
  }

  return teamScan;
}

// Function สร้างตั๋วหลายตลาดใต้งานรถเดียวจาก Gate (lock งานรถก่อนเสมอ กัน Gate ยิงซ้ำพร้อมกัน)
export async function createGateBusinessTickets(
  input: BoothJobJobCreateInput,
  payloadSnapshot: Prisma.InputJsonValue,
  connection?: DbConnection
): Promise<{ ticketJob: TicketJobDto; marketJobs: MarketJobDto[]; isExistingVehicle: boolean }> {
  const dispatchNow = input.dispatch_now;
  const vehicleStatus = dispatchNow ? VEHICLE_JOB_STATUS.WORKING : VEHICLE_JOB_STATUS.WAIT;
  const requestedWorkersRequired = input.markets.reduce(
    (sum, market) => sum + Math.max(1, market.workers_required),
    0
  );

  // Lock เลขทุกตัวใน request ก่อน แล้วค่อย lock TicketJob
  await gateRepository.lockGateTicketNumbers(
    [input.ticketNumber, ...input.markets.map((market) => market.ticketNo)],
    connection
  );

  const existingTicketJob = await gateRepository.lockAndFindTicketJobByRef(
    input.ticketNumber,
    connection
  );

  // TicketNumber ของรถคันใหม่ห้ามตรงกับ TicketNo ที่เคยออกไปแล้ว
  if (!existingTicketJob) {
    const ticketNoOwner = await gateRepository.findMarketJobByTicketNo(input.ticketNumber, connection);

    if (ticketNoOwner) {
      throw new ApiError(
        409,
        "TICKET_NUMBER_CONFLICTS_WITH_TICKET_NO",
        "TicketNumber is already used as a TicketNo. TicketNumber and TicketNo must never share a number.",
        {
          ticketNumber: input.ticketNumber,
          existing_market_code: ticketNoOwner.marketCode,
          existing_status: ticketNoOwner.status,
        }
      );
    }
  }

  const ticketJob =
    existingTicketJob ??
    (await gateRepository.createTicketJob(
      {
        ticketNumber: input.ticketNumber,
        licensePlate: input.license_plate,
        licensePlateProvince: input.license_plate_province,
        vehicleType: input.vehicle_type,
        vehicleTypeCode: input.vehicle_type_code,
        workersRequired: requestedWorkersRequired,
        dispatchNow,
        status: vehicleStatus,
      },
      connection
    ));

  // เปิด dispatch คืนเมื่อ Gate เพิ่มตั๋วหลัง release-workers
  const canReopenDispatch =
    existingTicketJob?.status === VEHICLE_JOB_STATUS.WAIT ||
    existingTicketJob?.status === VEHICLE_JOB_STATUS.RELEASED;
  // รถที่ปิดไปแล้วได้ตั๋วใหม่ ต้องเปิดรถกลับมาทำงาน ไม่งั้นจะไม่มีการหาคน
  const isReopeningTerminalVehicle =
    existingTicketJob !== null &&
    TERMINAL_JOB_STATUSES.includes(existingTicketJob.status);
  const shouldUpdateVehicle =
    existingTicketJob !== null &&
    (isReopeningTerminalVehicle ||
      existingTicketJob.license_plate !== input.license_plate ||
      existingTicketJob.license_plate_province !== input.license_plate_province ||
      existingTicketJob.vehicle_type !== input.vehicle_type ||
      existingTicketJob.vehicle_type_code !== input.vehicle_type_code ||
      (dispatchNow && !existingTicketJob.dispatch_now) ||
      (dispatchNow && canReopenDispatch));

  const savedTicketJob =
    shouldUpdateVehicle && existingTicketJob
      ? await gateRepository.updateTicketJobDetails(
        ticketJob.id,
        {
          licensePlate: input.license_plate,
          licensePlateProvince: input.license_plate_province,
          vehicleType: input.vehicle_type,
          vehicleTypeCode: input.vehicle_type_code,
          dispatchNow: isReopeningTerminalVehicle
            ? dispatchNow
            : existingTicketJob.dispatch_now || dispatchNow,
          status: isReopeningTerminalVehicle || (dispatchNow && canReopenDispatch)
            ? vehicleStatus
            : existingTicketJob.status,
        },
        connection
      )
      : ticketJob;
  const marketStatus =
    savedTicketJob.status === VEHICLE_JOB_STATUS.WORKING || dispatchNow
      ? VEHICLE_JOB_STATUS.WORKING
      : VEHICLE_JOB_STATUS.WAIT;
  const marketJobs: MarketJobDto[] = [];

  for (const market of input.markets) {
    await assertTicketNoNotIssued(market.ticketNo, savedTicketJob.id, input.ticketNumber, connection);

    const marketJob = await gateRepository.createMarketJob(
      {
        ticketJobId: savedTicketJob.id,
        ticketNo: market.ticketNo,
        ticketCreatedAt: market.ticket_created_at,
        boothCount: market.booth_count,
        gateTransactionRef: market.gate_transaction_ref,
        workersRequired: Math.max(1, market.workers_required),
        marketCode: market.marketCode,
        marketName: market.marketName,
        dropoffPoint: market.dropoff_point,
        gateNo: input.gate_no,
        gateClientId: input.gate_client_id,
        status: marketStatus,
      },
      connection
    );

    await gateRepository.createBoothJobsWithProducts(
      savedTicketJob.id,
      marketJob.id,
      market.booths,
      TICKET_STATUS.WAIT,
      connection
    );

    marketJobs.push(marketJob);
  }

  // จำนวน worker ของงานรถ = ผลรวมของทุกตั๋วที่ยัง active
  const workersRequiredSum = await gateRepository.sumActiveMarketJobWorkersRequired(
    savedTicketJob.id,
    connection
  );

  // ปิดรับ Ticket เพิ่มหลัง Gate create สำเร็จ
  const ticketsClosedAt = savedTicketJob.tickets_closed_at
    ? new Date(savedTicketJob.tickets_closed_at)
    : new Date();

  // เก็บค่าเดิมก่อน finalize เขียนทับ
  const previousTeam = existingTicketJob
    ? { workers_required: existingTicketJob.workers_required, work_started_at: existingTicketJob.work_started_at }
    : null;
  const finalizedTicketJob = await gateRepository.finalizeTicketJob(
    savedTicketJob.id,
    {
      workersRequired: workersRequiredSum ?? requestedWorkersRequired,
      ticketsClosedAt,
    },
    connection
  );
  const finalTicketJob = previousTeam
    ? await applyGateWorkersRequiredChange(previousTeam, finalizedTicketJob, connection)
    : finalizedTicketJob;

  if (existingTicketJob) {
    await syncWorkingTeamAfterGateChange(finalTicketJob, connection);
  }

  await gateRepository.createGateRequestLog(
    {
      gateTransactionRef: input.markets[0].gate_transaction_ref,
      requestType: "CREATE",
      gateNo: input.gate_no,
      gateClientId: input.gate_client_id,
      ticketJobId: finalTicketJob.id,
      marketJobId: marketJobs.length === 1 ? marketJobs[0].id : null,
      payloadSnapshot,
    },
    connection
  );

  return {
    ticketJob: finalTicketJob,
    marketJobs,
    // TicketNumber นี้มีงานรถอยู่แล้ว (Gate เพิ่มตั๋วให้รถเดิม)
    isExistingVehicle: existingTicketJob !== null,
  };
}

// Function สร้าง response เมื่อ Gate ส่ง request เดิม
function buildGateReplayResponse(
  response: BoothJobJobResponse,
  payloadSnapshot: unknown
): BoothJobJobResponse {
  const responseRecord =
    response as unknown as Record<string, unknown>;

  if (
    !("Vehicle" in responseRecord) ||
    !("Markets" in responseRecord)
  ) {
    throw new ApiError(
      409,
      "GATE_REQUEST_RESPONSE_NOT_READY",
      "Gate request already exists but its response snapshot is not ready."
    );
  }

  const status = isBoothJobJobBody(payloadSnapshot)
    ? buildBoothJobResponseStatus(payloadSnapshot.Dispatch)
    : response.Vehicle.Status;

  return {
    ...response,
    Result: "REPLAYED",
    Vehicle: {
      ...response.Vehicle,
      Status: status,
    },
  };
}

// Function ดึงตัวเลือกตลาด แผง สินค้า และบรรจุภัณฑ์ สำหรับช่วยทดสอบ Gate request
export async function getGateOptions(
  query: unknown
): Promise<GateOptionsResponse> {
  const rawQuery = query as {
    MarketCode?: unknown;
  };

  const normalizedMarketCode =
    typeof rawQuery.MarketCode === "string"
      ? rawQuery.MarketCode.trim() || undefined
      : undefined;

  const [
    marketRows,
    boothOptions,
    productRows,
  ] = await Promise.all([
    gateRepository.listGateMarketOptions(
      normalizedMarketCode
    ),

    normalizedMarketCode
      ? gateRepository.listGateBoothOptionsByMarketCode(
        normalizedMarketCode
      )
      : Promise.resolve([]),

    normalizedMarketCode
      ? Promise.resolve([])
      : gateRepository.listGateProductPackageOptions(),
  ]);

  // จัด Market
  const Markets = marketRows.flatMap((market) =>
    market.marketName
      ? [
        {
          MarketCode: market.marketCode,
          MarketName: market.marketName,
        },
      ]
      : []
  );

  // นับ ProductCode + PackageCode ก่อน เพราะ POST /api/gate/tickets จะ Reject ถ้าคู่นี้ตรงมากกว่า 1 record
  const pairCounts = new Map<string, number>();

  for (const row of productRows) {
    const key =
      `${row.productCode}:${row.packageCode}`;

    pairCounts.set(
      key,
      (pairCounts.get(key) ?? 0) + 1
    );
  }

  // Group Product -> Packages
  const productMap =
    new Map<string, GateProductOption>();

  for (const row of productRows) {
    const pairKey =
      `${row.productCode}:${row.packageCode}`;

    // ไม่ส่ง Product + Package ที่ ambiguous
    if (pairCounts.get(pairKey) !== 1) {
      continue;
    }

    let product =
      productMap.get(row.productCode);

    if (!product) {
      product = {
        ProductCode: row.productCode,
        ProductName: row.productName,
        Packages: [],
      };

      productMap.set(
        row.productCode,
        product
      );
    }

    product.Packages.push({
      PackageCode: row.packageCode,
      PackageName: row.packageName,
      PackageWeight: row.packageWeight,
    });
  }

  return {
    Markets,
    Booths: boothOptions,
    Products: Array.from(
      productMap.values()
    ),
  };
}

// Function ตอบ request ที่ gate_transaction_ref เคยบันทึกไว้แล้ว (payload ต่างหรือยังไม่มี response = 409)
function resolveExistingGateRequest(
  existingGateRequest: GateRequestReplayRecord,
  input: BoothJobJobBody
): BoothJobJobResponse {
  if (
    !arePayloadsEqual(
      existingGateRequest.payload_snapshot,
      input
    )
  ) {
    logger.warn("Gate request payload mismatch", {
      gate_transaction_ref: existingGateRequest.gate_transaction_ref,
      ticketNumber: input.TicketNumber,
    });

    throw new ApiError(
      409,
      "GATE_TRANSACTION_REF_PAYLOAD_MISMATCH",
      "gate_transaction_ref already exists with a different payload.",
      {
        duplicate_field: "gate_transaction_ref",
        gate_transaction_ref: existingGateRequest.gate_transaction_ref,
      }
    );
  }

  if (!existingGateRequest.response_snapshot) {
    throw new ApiError(
      409,
      "GATE_REQUEST_RESPONSE_NOT_READY",
      "Gate request already exists but its response snapshot is not ready.",
      {
        duplicate_field: "gate_transaction_ref",
        gate_transaction_ref: existingGateRequest.gate_transaction_ref,
      }
    );
  }

  logger.info("Gate request replayed", {
    gate_transaction_ref: existingGateRequest.gate_transaction_ref,
    ticketNumber: input.TicketNumber,
  });

  return buildGateReplayResponse(
    existingGateRequest.response_snapshot,
    existingGateRequest.payload_snapshot
  );
}

// Function สร้างตั๋วหลายตลาดของรถ 1 คันจาก Gate
export async function createTicketJobFromGate(
  body: unknown,
  gateClient?: PublicGateClient
): Promise<BoothJobJobResponse> {
  const input =
    parseWithSchema<BoothJobJobBody>(
      boothJobJobBodySchema,
      body
    );

  setLogContext({ ticketNumber: input.TicketNumber, ticketNos: input.Markets.map((market) => market.TicketNo) });

  const gateTransactionRef =
    buildGateTransactionRef(input);

  const existingGateRequest =
    await gateRepository.findGateRequestReplayByRef(
      gateTransactionRef
    );

  // คืน response เดิมเมื่อ Request เดิมถูกส่งซ้ำ
  if (existingGateRequest) {
    return resolveExistingGateRequest(existingGateRequest, input);
  }

  const createResult =
    await withTransaction(
      async (transaction) => {
        // Resolve Master + Worker requirement, Rate snapshot และ Vendor LINE ของทุกตลาด (ยังไม่คำนวณเงินจริง)
        const preparedMarkets: Array<{
          market: BoothJobJobBody["Markets"][number];
          prepared: PreparedGateBooths;
        }> = [];

        for (const market of input.Markets) {
          preparedMarkets.push({
            market,
            prepared: await prepareGateBooths(market, transaction),
          });
        }

        const { ticketJob, marketJobs, isExistingVehicle } =
          await createGateBusinessTickets(
            {
              ticketNumber: input.TicketNumber,
              license_plate: input.LicensePlate,
              license_plate_province: input.LicensePlateProvince,
              vehicle_type: input.VehicleTypeName,
              vehicle_type_code: input.VehicleTypeCode,
              dispatch_now: input.Dispatch,
              gate_no: input.GateNo,
              gate_client_id: gateClient?.id ?? null,
              markets: preparedMarkets.map(({ market, prepared }) =>
                buildGateMarketCreateInput(market, gateTransactionRef, prepared)
              ),
            },
            input as unknown as Prisma.InputJsonValue,
            transaction
          );

        // สร้าง response จากผลการสร้างโดยตรง ไม่ต้อง reload
        const response =
          buildPublicBoothJobJobResponse(
            ticketJob,
            marketJobs.map((marketJob, index) =>
              buildMarketResponse(
                marketJob,
                preparedMarkets[index].prepared.preparation.booths.map(buildBoothResponseFromPreparation)
              )
            ),
            input.GateNo,
            input.Dispatch,
            "CREATED"
          );

        // เก็บ response สำหรับ replay
        await gateRepository.updateGateRequestResponse(
          gateTransactionRef,
          response as unknown as Prisma.InputJsonValue,
          transaction
        );

        return {
          ticket_job_id: ticketJob.id as number | null,
          dispatch_vehicle_job_id: input.Dispatch ? ticketJob.id : null,
          is_existing_vehicle: isExistingVehicle,
          added_markets: marketJobs.map((marketJob) => ({ id: marketJob.id })),
          response,
          vendorLineTargetsByMarket: preparedMarkets.map(
            ({ prepared }) => prepared.vendorLineTargetsByBoothCode
          ),
        };
      }
    ).catch(async (error) => {
      // request เดิมที่ยิงพร้อมกันอาจผ่าน pre-check แล้วมาชน unique ทีหลัง
      // จึงอ่าน gate_transaction_ref ใหม่ก่อนเสมอ ถ้ามีแล้วตอบแบบ replay
      const replay = await gateRepository.findGateRequestReplayByRef(gateTransactionRef);

      if (replay) {
        return {
          ticket_job_id: null,
          dispatch_vehicle_job_id: null,
          is_existing_vehicle: false,
          added_markets: [] as Array<{ id: number }>,
          response: resolveExistingGateRequest(replay, input),
          vendorLineTargetsByMarket: [] as Array<Map<string, VendorLineTargetDto[]>>,
        };
      }

      const targetText = readUniqueConstraintTarget(error);

      // ด่านสุดท้ายถ้าหลุด pre-check มาชน unique index ของ TicketNo
      if (targetText !== null && targetText.includes("ticket_no")) {
        throw new ApiError(
          409,
          "TICKET_NO_ALREADY_EXISTS",
          "TicketNo was already issued to another ticket, including cancelled ones. Issue a new TicketNo.",
          {
            ticketNos: input.Markets.map((market) => market.TicketNo),
          }
        );
      }

      if (targetText !== null && targetText.includes("ticket_number")) {
        throw new ApiError(
          409,
          "GATE_TICKET_ALREADY_EXISTS",
          "TicketNo already exists under this TicketNumber. Use PUT /api/gate/tickets/{ticketNo} to edit it.",
          {
            ticketNumber: input.TicketNumber,
          }
        );
      }

      throw error;
    });

  const response =
    createResult.response;

  // replay (ticket_job_id = null) ไม่ได้สร้างอะไรใหม่ จึงไม่แจ้งเตือนซ้ำ
  if (createResult.ticket_job_id === null) {
    return response;
  }

  // เพิ่มตั๋วให้รถเดิม: เก็บ Worker ที่อยู่บนรถก่อน dispatch (คนที่ได้งานใหม่จะได้ WORKER_ASSIGNED แทน)
  const workerIdsOnVehicle = createResult.is_existing_vehicle
    ? [
      ...new Set(
        (await assignmentRepository.listActiveAssignmentsByTicketJob(createResult.ticket_job_id))
          .map((assignment) => assignment.worker_id)
      ),
    ]
    : [];

  // เรียก Worker เมื่อ Dispatch = true
  if (createResult.dispatch_vehicle_job_id !== null) {
    try {
      await dispatchReadyWorkers();
    } catch (error) {
      logger.error("Gate ticket was created but worker dispatch failed.", {
        error,
      });
    }
  }

  publishDriverJobUpdate(createResult.ticket_job_id, "DRIVER_JOB_UPDATED");

  if (createResult.is_existing_vehicle) {
    // รถเดิมได้ตั๋วเพิ่ม: แจ้ง Admin และ Worker บนรถด้วย TICKET_JOB_UPDATED (ตั๋วละ 1 event รูปแบบเดียวกับ Gate PUT)
    response.Markets.forEach((market, index) => {
      const addedMarket = createResult.added_markets[index];
      const eventPayload = {
        changeType: "TICKET_ADDED",
        ticketNumber: response.TicketNumber,
        ticketNo: market.TicketNo,
        gateNo: response.GateNo,
        marketJobId: String(addedMarket.id),
        marketCode: market.MarketCode,
        marketName: market.MarketName,
        previousMarketCode: null,
        dropoffPoint: market.DropoffPoint,
        addedBoothCodes: market.Booths.map((booth) => booth.BoothCode),
        updatedBoothCodes: [],
        removedBoothCodes: [],
        marketChanged: false,
        dropoffPointChanged: false,
        ticketWorkersRequired: market.WorkerCount,
        workersRequired: response.WorkerCount,
      };

      publishRealtimeEvent({
        type: "TICKET_JOB_UPDATED",
        title: "Ticket added by Gate",
        message: `Ticket ${market.TicketNo} was added to vehicle job ${response.TicketNumber} by Gate ${response.GateNo}.`,
        notification_params: eventPayload,
        payload: eventPayload,
        worker_payload: eventPayload,
        admin: true,
        worker_ids: workerIdsOnVehicle,
      });
    });
  } else {
    const ticketNos = response.Markets.map((market) => market.TicketNo);

    // แจ้ง Admin ว่ามีงานรถใหม่
    publishNotification({
      type: "VEHICLE_JOB_CREATED",
      title: "Vehicle job created",
      message: `Vehicle job ${response.TicketNumber} (${ticketNos.join(", ")}) was created from Gate ${response.GateNo}.`,
      payload: {
        ticketNumber: response.TicketNumber,
        ticketNos,
        gateNo: response.GateNo,
        gate_transaction_ref: gateTransactionRef,
        license_plate: response.Vehicle.LicensePlate,
        license_plate_province: response.Vehicle.LicensePlateProvince,
        status: response.Vehicle.Status,
        dispatch_now: input.Dispatch === true,
      },
      audience: {
        roles: ["admin"],
      },
    });
  }

  // แจ้ง Vendor ของแต่ละแผง
  try {
    for (const [index, targets] of createResult.vendorLineTargetsByMarket.entries()) {
      const market = response.Markets[index];

      await notifyVendorBoothJobCreated(response, market, market.Booths, targets);
    }
  } catch (error) {
    logger.error("Gate ticket was created but vendor notification failed.", {
      error,
    });
  }

  return response;
}

// Function อ่านชื่อ constraint ที่ชนจาก Prisma P2002 (อ่านทั้ง meta.target และ driver adapter) ไม่ใช่ P2002 คืน null
function readUniqueConstraintTarget(error: unknown): string | null {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return null;
  }

  const targetFromMeta = error.meta?.target;
  // adapter-pg >= 7.10 ส่งชื่อ index แทน fields เมื่อ Postgres ระบุ constraint มา
  const constraintFromDriverAdapter =
    (error.meta?.driverAdapterError as { cause?: { constraint?: { fields?: string[]; index?: string } } } | undefined)
      ?.cause?.constraint;
  const targetFromDriverAdapter =
    constraintFromDriverAdapter?.fields ?? constraintFromDriverAdapter?.index;

  return (
    Array.isArray(targetFromMeta)
      ? targetFromMeta.join(",")
      : Array.isArray(targetFromDriverAdapter)
        ? targetFromDriverAdapter.join(",")
        : String(targetFromMeta ?? targetFromDriverAdapter ?? "")
  ).toLowerCase();
}

/* -------------------------------------- Gate Ticket Lookup -------------------------------------- */

// Function ตรวจว่า TicketNo ยังไม่เคยออก (ไม่ซ้ำตั๋วใดเลยรวมที่ยกเลิกแล้ว และไม่ตรงกับ TicketNumber ใดๆ)
async function assertTicketNoNotIssued(
  ticketNo: string,
  ticketJobId: number,
  ticketNumber: string,
  connection?: DbConnection
): Promise<void> {
  const ticketNoOwner = await gateRepository.findMarketJobByTicketNo(ticketNo, connection);

  // ตั๋วเดิมของรถคันนี้ที่ยังไม่ยกเลิก ต้องแก้ผ่าน PUT ไม่เพิ่มแผงต่อท้ายผ่าน POST
  if (
    ticketNoOwner &&
    ticketNoOwner.vehicle_job_id === ticketJobId &&
    ticketNoOwner.status !== VEHICLE_JOB_STATUS.CANCELLED
  ) {
    throw new ApiError(
      409,
      "GATE_TICKET_ALREADY_EXISTS",
      "TicketNo already exists under this TicketNumber. Use PUT /api/gate/tickets/{ticketNo} to edit it.",
      { ticketNumber, ticketNo }
    );
  }

  if (ticketNoOwner) {
    const ownerTicketJob = await ticketJobRepository.findTicketJobById(ticketNoOwner.vehicle_job_id, connection);

    throw new ApiError(
      409,
      "TICKET_NO_ALREADY_EXISTS",
      "TicketNo was already issued to another ticket, including cancelled ones. Issue a new TicketNo.",
      {
        ticketNo,
        existing_ticket_number: ownerTicketJob?.ticket_number ?? null,
        existing_market_code: ticketNoOwner.marketCode,
        existing_status: ticketNoOwner.status,
      }
    );
  }

  if (await ticketJobRepository.findTicketJobByRef(ticketNo, connection)) {
    throw new ApiError(
      409,
      "TICKET_NO_CONFLICTS_WITH_TICKET_NUMBER",
      "TicketNo is already used as a TicketNumber. TicketNumber and TicketNo must never share a number.",
      { ticketNo }
    );
  }
}

// Function ตรวจ TicketNo จาก path (ตัวเลข 14 หลัก)
function parseGateTicketNo(ticketNoParam: unknown): string {
  const parsed = gateTicketNoSchema.safeParse(ticketNoParam);

  if (!parsed.success) {
    throw new ApiError(
      400,
      "INVALID_TICKET_NO",
      "TicketNo must be exactly 14 digits, numbers only."
    );
  }

  return parsed.data;
}

// Function หาตั๋วจาก TicketNo ทุกสถานะ รวมตั๋วที่ Admin ยกเลิกแล้ว (TicketNo ไม่ซ้ำทั้งระบบ)
async function requireGateTicketByTicketNo(ticketNo: string): Promise<MarketJobDto> {
  const marketJob = await gateRepository.findMarketJobByTicketNo(ticketNo);

  if (!marketJob) {
    throw new ApiError(404, "GATE_TICKET_NOT_FOUND", "Ticket not found.", {
      ticketNo,
    });
  }

  return marketJob;
}

// Function สร้าง error ตั๋วที่ Admin ยกเลิกแล้ว Gate แก้ไม่ได้และต้องออก TicketNo ใหม่
function buildGateTicketCancelledError(ticketNo: string): ApiError {
  return new ApiError(
    409,
    "GATE_TICKET_CANCELLED",
    "Ticket was cancelled by an admin and can no longer be edited. Issue a new TicketNo instead.",
    { ticketNo }
  );
}

// Function หาเหตุผลที่ตั๋วแก้ไขไม่ได้ (null = แก้ได้) ส่งยอดแผงใดแล้วล็อกทั้งใบ ให้ Admin จัดการต่อ
function resolveGateTicketLockReason(
  isClosed: boolean,
  isSubmitted: boolean
): GateTicketLockReason | null {
  if (isClosed) {
    return "BOOTH_ALREADY_CLOSED";
  }

  return isSubmitted ? "TICKET_ALREADY_SUBMITTED" : null;
}

// Function ดึงตั๋ว 1 ใบจาก TicketNo สำหรับให้ Gate UI แสดงและแก้ไข
export async function getGateTicket(
  ticketNoParam: unknown
): Promise<GateTicketDetailResponse> {
  const ticketNo = parseGateTicketNo(ticketNoParam);
  const marketJob = await requireGateTicketByTicketNo(ticketNo);
  const [ticketJob, booths, isSubmitted] = await Promise.all([
    ticketJobRepository.findTicketJobById(marketJob.vehicle_job_id),
    gateRepository.listGateTicketBooths(marketJob.id),
    gateRepository.hasTicketCompletionSubmissionForMarketJob(marketJob.id),
  ]);

  if (!ticketJob) {
    throw new ApiError(404, "GATE_TICKET_NOT_FOUND", "Ticket not found.", {
      ticketNo,
    });
  }

  setLogContext({ ticketNumber: ticketJob.ticket_number, ticketJobId: ticketJob.id });

  const isClosed =
    TERMINAL_JOB_STATUSES.includes(ticketJob.status) ||
    TERMINAL_JOB_STATUSES.includes(marketJob.status);
  const lockReason = resolveGateTicketLockReason(isClosed, isSubmitted);
  const detailBooths = booths.map((booth) => ({
    ...buildBoothResponseFromRecord(booth),
    Status: booth.status,
    Editable: lockReason === null,
    LockReason: lockReason,
  }));

  return {
    TicketNumber: ticketJob.ticket_number,
    GateNo: marketJob.gate_no,
    Vehicle: {
      LicensePlate: ticketJob.license_plate,
      LicensePlateProvince: ticketJob.license_plate_province,
      VehicleTypeCode: ticketJob.vehicle_type_code,
      VehicleTypeName: ticketJob.vehicle_type,
      Status: ticketJob.status,
    },
    Market: {
      ...buildMarketResponse(marketJob, []),
      Status: marketJob.status,
      MarketEditable: lockReason === null,
      Booths: detailBooths,
    },
    WorkerCount: ticketJob.workers_required,
    Qr: {
      DriverQrToken: ticketJob.driver_qr_token,
      DriverQrUrl: buildDriverQrUrl(ticketJob.driver_qr_token),
    },
  };
}

/* -------------------------------------- Gate Ticket Update -------------------------------------- */

// Function สร้าง key สินค้าของแผงไว้เทียบว่าเหมือนเดิมหรือไม่ (ProductCode + PackageCode + Quantity)
function buildBoothProductKey(
  products: Array<{ code: string; packageCode: string; quantity: number }>
): string {
  return products
    .map((product) => `${product.code}:${product.packageCode}:${product.quantity}`)
    .sort()
    .join("|");
}

// Function เทียบแผงเดิมกับแผงที่ Gate ส่งมา แยกเป็นเพิ่ม/ยกเลิก/แทนที่/คงเดิม
function planGateBoothChanges(
  currentBooths: GateTicketBoothRecord[],
  nextBooths: BoothJobJobBoothBody[],
  marketChanged: boolean
): GateBoothChangePlan {
  const plan: GateBoothChangePlan = {
    added: [],
    removed: [],
    updated: [],
    unchanged: [],
  };
  const nextByBoothCode = new Map(nextBooths.map((booth) => [booth.BoothCode, booth]));
  const currentBoothCodes = new Set<string>();

  for (const current of currentBooths) {
    const next = nextByBoothCode.get(current.booth_code);
    // ย้ายตลาด = แผงที่ยังอยู่ทุกแผงถูกแก้ (ชื่อแผง/Vendor/rate เปลี่ยนตามตลาดใหม่)
    const isSame =
      !marketChanged &&
      next !== undefined &&
      buildBoothProductKey(
        current.products.map((product) => ({
          code: product.product_code,
          packageCode: product.package_code,
          quantity: product.quantity,
        }))
      ) ===
        buildBoothProductKey(
          next.Products.map((product) => ({
            code: product.ProductCode,
            packageCode: product.PackageCode,
            quantity: product.Quantity,
          }))
        );

    currentBoothCodes.add(current.booth_code);

    if (isSame) {
      plan.unchanged.push(current);
    } else if (next) {
      plan.updated.push({ current, next });
    } else {
      plan.removed.push(current);
    }
  }

  plan.added = nextBooths.filter((booth) => !currentBoothCodes.has(booth.BoothCode));

  return plan;
}

// Function ปรับช่องที่ยังไม่ได้เติมเมื่อ Gate เปลี่ยนจำนวนคนหลังทีมเริ่มงานแล้ว
async function applyGateWorkersRequiredChange(
  previous: Pick<TicketJobDto, "workers_required" | "work_started_at">,
  next: TicketJobDto,
  connection?: DbConnection
): Promise<TicketJobDto> {
  // เพิ่ม = ช่องว่างให้ Admin เลือกคนเอง (ไม่ dispatch) ลด = ใช้ช่องว่างก่อน แล้วค่อยตัดคนที่ยังไม่สแกน
  const delta = next.workers_required - previous.workers_required;

  if (delta === 0 || !previous.work_started_at) {
    return next;
  }

  await ticketJobRepository.adjustTicketJobUnfilledSlotCount(next.id, delta, connection);

  return (await ticketJobRepository.findTicketJobById(next.id, connection)) ?? next;
}

// Function ยกเลิก assignment ที่ยังไม่สแกนส่วนที่เกินจำนวนที่ต้องใช้ (คนที่ได้งานล่าสุดก่อน คนที่สแกนแล้วทำงานต่อ)
async function cancelExcessUnscannedAssignments(
  ticketJob: TicketJobDto,
  connection: DbConnection
): Promise<TicketJobAssignmentDto[]> {
  const effectiveWorkersRequired = resolveEffectiveWorkersRequired(
    ticketJob.workers_required,
    ticketJob.unfilled_slot_count
  );
  const activeAssignments = await assignmentRepository.listActiveAssignmentsByTicketJob(
    ticketJob.id,
    connection
  );
  const excessCount = activeAssignments.length - effectiveWorkersRequired;

  if (excessCount <= 0) {
    return [];
  }

  const candidates = activeAssignments
    .filter((assignment) => !SCANNED_ASSIGNMENT_STATUSES.includes(assignment.status))
    .sort((left, right) => right.id - left.id)
    .slice(0, excessCount);
  const cancelledAssignments: TicketJobAssignmentDto[] = [];

  for (const candidate of candidates) {
    // lock assignment ก่อนยกเลิก กัน race กับ worker ที่กำลัง accept/scan (แพ้ race = ข้าม)
    await connection.$queryRaw`SELECT id FROM ticket_job_assignments WHERE id = ${candidate.id} FOR UPDATE`;

    const cancelled = await assignmentRepository.cancelAssignment(
      candidate.id,
      connection,
      "gate_ticket_update"
    );

    if (cancelled) {
      cancelledAssignments.push(cancelled);
    }
  }

  return cancelledAssignments;
}

// Function คืน worker ที่ถูกยกเลิกเพราะคนเกินกลับหน้าคิว (หมดกะไป open_app) พร้อมแจ้งเตือน
async function requeueExcessGateAssignments(
  ticketJob: TicketJobDto,
  assignments: TicketJobAssignmentDto[]
): Promise<number[]> {
  if (assignments.length === 0) {
    return [];
  }

  await Promise.all(
    assignments.flatMap((assignment) => [
      removeAssignmentTimeout(assignment.id),
      removeScanTimeout(assignment.id),
      removeScanWarning(assignment.id),
    ])
  );

  const { requeuedWorkerIds, openAppWorkerIds } =
    await requeueWorkersAtFrontRespectingShift(
      assignments.map((assignment) => assignment.worker_id)
    );
  const [ticketNos, workerCodeMap] = await Promise.all([
    marketJobRepository.listActiveTicketNosByTicketJobId(ticketJob.id),
    profileRepository.findWorkerCodeMapByAccountIds(
      assignments.map((assignment) => assignment.worker_id)
    ),
  ]);
  const assignmentByWorkerId = new Map(
    assignments.map((assignment) => [assignment.worker_id, assignment])
  );
  // แจ้ง Worker (สถานะคิวล่าสุดใน event เดียว) และ Admin ให้ Worker Board อัปเดต เหมือนตอน Admin ยกเลิกคน
  const notifyCancelled = async (workerId: number, workerStatus: string, reason: string) => {
    const workerCode = workerCodeMap.get(workerId) ?? null;
    const queue = await getWorkerQueueStatus(workerId);
    const queuePayload = buildWorkerQueueSocketPayload(queue, workerCode);

    sendWorkerSocketEvent(workerId, "WORKER_STATUS_CHANGED", {
      status: workerStatus,
      reason,
      queue: queuePayload,
    });
    sendWorkerSocketEvent(workerId, "ASSIGNMENT_CANCELLED", {
      ticketNumber: ticketJob.ticket_number,
      ticketNos,
      reason,
      worker_status: workerStatus,
      queue: queuePayload,
    });
    publishAdminWorkerStatusChanged({
      title: workerStatus === WORKER_WORK_STATUS.READY
        ? "Worker returned to queue"
        : "Worker moved to open_app",
      message: `Worker ${workerCode ?? workerId} was removed from vehicle job ${ticketJob.ticket_number} because Gate updated the ticket and fewer workers are needed.`,
      workerCode,
      queue,
      reason,
      assignment: assignmentByWorkerId.get(workerId) ?? null,
    });
  };

  for (const workerId of requeuedWorkerIds) {
    await notifyCancelled(workerId, WORKER_WORK_STATUS.READY, "gate_ticket_update_requeue");
  }

  for (const workerId of openAppWorkerIds) {
    await notifyCancelled(workerId, WORKER_WORK_STATUS.OPEN_APP, "gate_ticket_update_shift_ended");
  }

  return requeuedWorkerIds;
}

// Function สร้าง key สินค้าในแผง (ProductCode + PackageCode) ใช้จับคู่สินค้าเดิมกับที่ Gate ส่งมา
function buildProductBusinessKey(productCode: string, packageCode: string): string {
  return `${productCode}:${packageCode}`;
}

// Function แก้แผงเดิมในแถวเดิม: อัปเดตชื่อแผง/Vendor และสินค้า (เดิม = update, ใหม่ = create, ที่หายไป = ลบ)
async function applyGateBoothUpdate(
  current: GateTicketBoothRecord,
  next: GateBoothCreateInput,
  marketChanged: boolean,
  connection: DbConnection
): Promise<void> {
  await gateRepository.updateBoothJobAfterGateEdit(
    current.id,
    {
      boothName: next.boothName,
      vendorLineId: next.vendor_line_id ?? null,
    },
    connection
  );

  const currentProductByKey = new Map(
    current.products.map((product) => [
      buildProductBusinessKey(product.product_code, product.package_code),
      product,
    ])
  );
  const nextProductKeys = new Set<string>();
  const productsToCreate: GateBoothCreateInput["products"] = [];

  for (const product of next.products) {
    const key = buildProductBusinessKey(product.productCode, product.packageCode);
    const existing = currentProductByKey.get(key);

    nextProductKeys.add(key);

    if (!existing) {
      productsToCreate.push(product);
      continue;
    }

    // rate snapshot คงเดิมตามกติกา (Master Rate ที่แก้ทีหลังไม่กระทบงานเดิม) ยกเว้นย้ายตลาดที่ rate ผูกกับตลาด
    await gateRepository.updateTicketProductAfterGateEdit(
      existing.id,
      product,
      { refreshRateSnapshot: marketChanged },
      connection
    );
  }

  await gateRepository.createTicketProducts(current.id, productsToCreate, connection);
  await gateRepository.deleteTicketProducts(
    current.products
      .filter(
        (product) =>
          !nextProductKeys.has(buildProductBusinessKey(product.product_code, product.package_code))
      )
      .map((product) => product.id),
    connection
  );
}

// Function สร้างสภาพตั๋ว 1 ใบเก็บเป็นประวัติก่อน/หลังแก้ไข
function buildGateTicketRevisionSnapshot(
  marketJob: MarketJobDto,
  booths: GateTicketBoothRecord[]
): GateTicketRevisionSnapshot {
  return {
    MarketJobId: String(marketJob.id),
    TicketNo: marketJob.ticket_no,
    MarketCode: marketJob.marketCode,
    MarketName: marketJob.marketName,
    DropoffPoint: marketJob.dropoff_point,
    WorkerCount: marketJob.workers_required,
    Booths: booths.map((booth) => ({
      BoothJobId: String(booth.id),
      BoothCode: booth.booth_code,
      BoothName: booth.booth_name,
      Status: booth.status,
      Products: booth.products.map((product) => ({
        TicketProductId: String(product.id),
        ProductCode: product.product_code,
        PackageCode: product.package_code,
        Quantity: product.quantity,
        WorkerCount: product.required_worker_count,
      })),
    })),
  };
}

// Function บันทึกการยกเลิกแผง/ตลาดที่เกิดจาก Gate แก้ไขตั๋วลง admin_action_logs
async function logGateCancellation(
  input: {
    actionType: typeof ADMIN_ACTION_TYPE.MARKET_JOB_CANCELLED | typeof ADMIN_ACTION_TYPE.STALL_JOB_CANCELLED;
    ticketJobId: number;
    marketJobId: number;
    boothJobId?: number;
    gateNo: string;
    gateClient?: PublicGateClient;
    metadata: Record<string, unknown>;
  },
  connection: DbConnection
): Promise<void> {
  await adminActionLogRepository.create(
    {
      vehicle_job_id: input.ticketJobId,
      market_job_id: input.marketJobId,
      gate_ticket_id: input.boothJobId ?? null,
      action_type: input.actionType,
      reason_code: GATE_TICKET_UPDATE_REASON_CODE,
      reason_text: `Gate ${input.gateNo} updated the ticket.`,
      actor_account_id: null,
      actor_gate_client_id: input.gateClient?.id ?? null,
      metadata: {
        source: "gate_ticket_update",
        gate_no: input.gateNo,
        gate_client_id: input.gateClient?.client_id ?? null,
        gate_client_name: input.gateClient?.name ?? null,
        ...input.metadata,
      },
    },
    connection
  );
}

// Function กัน Gate ลบแผง/สินค้าจนตั๋วว่าง ตั๋วต้องเหลืออย่างน้อย 1 แผงที่มีสินค้าเสมอ
function assertGateTicketKeepsMinimumBooths(ticketNo: string, body: unknown): void {
  // ตอบ 409 ก่อนตรวจ schema เพื่อแยกจาก payload ผิดรูปแบบ (400) การยกเลิกตั๋วทำได้เฉพาะ Admin
  const booths = (body as { Booths?: unknown } | null)?.Booths;

  if (!Array.isArray(booths)) {
    return;
  }

  const emptyBoothCodes = booths
    .filter((booth) => {
      const products = (booth as { Products?: unknown } | null)?.Products;

      return Array.isArray(products) && products.length === 0;
    })
    .map((booth) => (booth as { BoothCode?: unknown } | null)?.BoothCode)
    .filter((boothCode): boothCode is string => typeof boothCode === "string");

  if (booths.length === 0 || emptyBoothCodes.length > 0) {
    throw new ApiError(
      409,
      "GATE_TICKET_MINIMUM_BOOTH_REQUIRED",
      "A ticket must keep at least one booth with at least one product. Gate cannot remove everything to cancel a ticket.",
      {
        ticketNo,
        ...(emptyBoothCodes.length > 0 && { boothCodes: emptyBoothCodes }),
      }
    );
  }
}

// Function แก้ไขตั๋ว 1 ใบจาก Gate ตาม TicketNo (ส่งสภาพสุดท้ายมาทั้งใบ ระบบเทียบกับของเดิมเอง)
export async function updateGateTicket(
  ticketNoParam: unknown,
  body: unknown,
  gateClient?: PublicGateClient
): Promise<GateTicketUpdateResponse> {
  const ticketNo = parseGateTicketNo(ticketNoParam);

  assertGateTicketKeepsMinimumBooths(ticketNo, body);

  const input = parseWithSchema<GateTicketUpdateBody>(gateTicketUpdateBodySchema, body);
  const lookedUpMarketJob = await requireGateTicketByTicketNo(ticketNo);

  if (lookedUpMarketJob.status === VEHICLE_JOB_STATUS.CANCELLED) {
    throw buildGateTicketCancelledError(ticketNo);
  }

  const result = await withTransaction(async (transaction) => {
    // ลำดับ lock เหมือนตอนสร้าง: ticket_jobs -> market_jobs -> booth_jobs
    await transaction.$queryRaw`SELECT id FROM ticket_jobs WHERE id = ${lookedUpMarketJob.vehicle_job_id} FOR UPDATE`;

    const ticketJob = await ticketJobRepository.findTicketJobById(
      lookedUpMarketJob.vehicle_job_id,
      transaction
    );

    setLogContext({ ticketNumber: ticketJob?.ticket_number, ticketJobId: ticketJob?.id });

    if (!ticketJob || TERMINAL_JOB_STATUSES.includes(ticketJob.status)) {
      throw new ApiError(
        409,
        "VEHICLE_JOB_CLOSED",
        "Vehicle job is already closed and its tickets can no longer be edited.",
        { ticketNo }
      );
    }

    const currentMarket = await gateRepository.lockAndFindMarketJobById(
      lookedUpMarketJob.id,
      transaction
    );

    if (currentMarket.status === VEHICLE_JOB_STATUS.CANCELLED) {
      throw buildGateTicketCancelledError(ticketNo);
    }

    if (TERMINAL_JOB_STATUSES.includes(currentMarket.status)) {
      throw new ApiError(
        409,
        "GATE_TICKET_CLOSED",
        "Ticket is already completed and can no longer be edited.",
        { ticketNo }
      );
    }

    const currentBooths = await gateRepository.lockAndListGateTicketBooths(currentMarket.id, transaction);

    // ส่งยอดแผงใดแล้วห้ามแก้ทั้งใบ (เช็คหลัง lock แผงทุกแผง จึงไม่ชนกับ Worker ที่กำลังส่งยอด)
    if (await gateRepository.hasTicketCompletionSubmissionForMarketJob(currentMarket.id, transaction)) {
      throw new ApiError(
        409,
        "TICKET_ALREADY_SUBMITTED",
        "Ticket cannot be edited after any of its booths was submitted. Ask an admin to handle it.",
        { ticketNo }
      );
    }

    // เก็บค่าเดิมไว้ก่อนแก้ไข (DTO อาจถูกอัปเดตทับระหว่าง transaction)
    const previousMarket = { ...currentMarket };
    const marketChanged = input.MarketCode !== currentMarket.marketCode;
    const plan = planGateBoothChanges(currentBooths, input.Booths, marketChanged);
    // แผงที่ Admin ยกเลิกไปแล้ว Gate เพิ่มกลับไม่ได้ (กันเขียนทับการยกเลิกของ Admin)
    const adminCancelledBooths = await gateRepository.listAdminCancelledBooths(
      currentMarket.id,
      plan.added.map((booth) => booth.BoothCode),
      transaction
    );

    if (adminCancelledBooths.length > 0) {
      throw new ApiError(
        409,
        "BOOTH_CANCELLED_BY_ADMIN",
        "Some booths were cancelled by an admin and cannot be added back by Gate. Remove them from the request or ask the admin.",
        { ticketNo, booths: adminCancelledBooths }
      );
    }

    const dropoffPointChanged = input.DropoffPoint !== (currentMarket.dropoff_point ?? "");
    const hasChanges =
      marketChanged ||
      dropoffPointChanged ||
      plan.added.length > 0 ||
      plan.removed.length > 0 ||
      plan.updated.length > 0;
    const teamScanBefore = await assignmentRepository.getTicketJobTeamScanReadiness(
      ticketJob.id,
      transaction
    );
    // ตรวจ master และเตรียมสินค้าเฉพาะแผงที่เพิ่มหรือแก้ (ย้ายตลาด = ทุกแผงที่ส่งมา)
    const boothsToPrepare = [...plan.added, ...plan.updated.map((item) => item.next)];
    const prepared = boothsToPrepare.length > 0
      ? await prepareGateBooths({ MarketCode: input.MarketCode, Booths: boothsToPrepare }, transaction)
      : null;
    const preparedBoothByCode = new Map(
      (prepared?.booths ?? []).map((booth) => [booth.boothCode, booth])
    );
    const cancelledBooths: CancelledGateBooth[] = plan.removed.map((booth) => ({
      id: booth.id,
      boothCode: booth.booth_code,
      boothName: booth.booth_name,
    }));

    // ใช้ CANCELLED เฉพาะแผงที่ Gate นำออกจริง
    for (const booth of plan.removed) {
      await ticketJobLifecycleService.cancelBoothJob(booth.id, transaction);
      await logGateCancellation(
        {
          actionType: ADMIN_ACTION_TYPE.STALL_JOB_CANCELLED,
          ticketJobId: ticketJob.id,
          marketJobId: currentMarket.id,
          boothJobId: booth.id,
          gateNo: input.GateNo,
          gateClient,
          metadata: {
            market_changed: marketChanged,
          },
        },
        transaction
      );
    }

    // แผงเดิมแก้ในแถวเดิม (BoothJob id, สถานะ และการถอด Worker จากแผงคงเดิม)
    for (const { current } of plan.updated) {
      await applyGateBoothUpdate(
        current,
        preparedBoothByCode.get(current.booth_code)!,
        marketChanged,
        transaction
      );
    }

    if (plan.added.length > 0) {
      await gateRepository.createBoothJobsWithProducts(
        ticketJob.id,
        currentMarket.id,
        plan.added.map((booth) => preparedBoothByCode.get(booth.BoothCode)!),
        TICKET_STATUS.WAIT,
        transaction
      );
    }

    // คิดจำนวน Worker ของตั๋วใหม่จาก snapshot ของแผงที่เหลือ (MAX) และของรถ (SUM)
    const finalBooths = await gateRepository.listGateTicketBooths(currentMarket.id, transaction);
    const marketWorkersRequired = Math.max(
      1,
      ...finalBooths.flatMap((booth) =>
        booth.products.map((product) => product.required_worker_count)
      )
    );
    // MarketJob แถวเดิม (id/TicketNo คงเดิม) แม้ย้ายตลาด
    const updatedMarket = await gateRepository.updateMarketJobAfterGateEdit(
      currentMarket.id,
      {
        marketCode: input.MarketCode,
        marketName: prepared?.preparation.market.marketName ?? currentMarket.marketName,
        boothCount: finalBooths.length,
        workersRequired: marketWorkersRequired,
        dropoffPoint: input.DropoffPoint,
      },
      transaction
    );
    const workersRequiredSum = await gateRepository.sumActiveMarketJobWorkersRequired(
      ticketJob.id,
      transaction
    );

    // เก็บค่าเดิมก่อน finalize เขียนทับ
    const previousTeam = {
      workers_required: ticketJob.workers_required,
      work_started_at: ticketJob.work_started_at,
    };
    let finalTicketJob = await applyGateWorkersRequiredChange(
      previousTeam,
      await gateRepository.finalizeTicketJob(
        ticketJob.id,
        {
          workersRequired: workersRequiredSum ?? marketWorkersRequired,
          ticketsClosedAt: ticketJob.tickets_closed_at
            ? new Date(ticketJob.tickets_closed_at)
            : new Date(),
        },
        transaction
      ),
      transaction
    );

    // รถที่ release ทีมไปแล้วได้แผงใหม่หรือแผงที่แก้ ต้องเปิด dispatch กลับมาหาคนลงแผง
    if (finalTicketJob.status === VEHICLE_JOB_STATUS.RELEASED && boothsToPrepare.length > 0) {
      finalTicketJob = await ticketJobRepository.updateTicketJobStatus(
        ticketJob.id,
        finalTicketJob.dispatch_now ? VEHICLE_JOB_STATUS.WORKING : VEHICLE_JOB_STATUS.WAIT,
        transaction
      );
    }

    const cancelledAssignments = hasChanges
      ? await cancelExcessUnscannedAssignments(finalTicketJob, transaction)
      : [];
    const teamScan = await syncWorkingTeamAfterGateChange(finalTicketJob, transaction);
    const completedTicketJob = await ticketJobLifecycleService.closeCompletedTicketJobIfReady(
      ticketJob.id,
      transaction
    );
    const responseTicketJob = completedTicketJob?.vehicle_job ??
      (await ticketJobRepository.findTicketJobById(ticketJob.id, transaction)) ??
      finalTicketJob;
    const updatedBoothCodes = plan.updated.map((item) => item.current.booth_code);
    const changes: GateTicketChangeSummary = {
      MarketChanged: marketChanged,
      DropoffPointChanged: dropoffPointChanged,
      Added: plan.added.map((booth) => booth.BoothCode),
      Removed: plan.removed.map((booth) => booth.booth_code),
      Updated: updatedBoothCodes,
      Unchanged: plan.unchanged.map((booth) => booth.booth_code),
      PreviousWorkerCount: previousMarket.workers_required,
      WorkerCount: updatedMarket.workers_required,
    };
    const beforeSnapshot = buildGateTicketRevisionSnapshot(previousMarket, currentBooths);
    const afterSnapshot = buildGateTicketRevisionSnapshot(updatedMarket, finalBooths);
    const response: GateTicketUpdateResponse = {
      ...buildPublicBoothJobJobResponse(
        responseTicketJob,
        [buildMarketResponse(updatedMarket, finalBooths.map(buildBoothResponseFromRecord))],
        input.GateNo,
        responseTicketJob.dispatch_now,
        hasChanges ? "UPDATED" : "NO_CHANGE"
      ),
      Changes: changes,
    };

    await gateRepository.createGateRequestLog(
      {
        gateTransactionRef: `GATE-UPD-${randomUUID()}`,
        requestType: "UPDATE",
        result: hasChanges ? "UPDATED" : "NO_CHANGE",
        gateNo: input.GateNo,
        gateClientId: gateClient?.id ?? null,
        ticketJobId: ticketJob.id,
        marketJobId: updatedMarket.id,
        payloadSnapshot: { TicketNo: ticketNo, ...input } as unknown as Prisma.InputJsonValue,
        responseSnapshot: response as unknown as Prisma.InputJsonValue,
        changeSummary: changes as unknown as Prisma.InputJsonValue,
        changeDetails: buildGateTicketChangeDetails(
          beforeSnapshot,
          afterSnapshot
        ) as unknown as Prisma.InputJsonValue,
        beforeSnapshot: beforeSnapshot as unknown as Prisma.InputJsonValue,
        afterSnapshot: afterSnapshot as unknown as Prisma.InputJsonValue,
      },
      transaction
    );

    return {
      response,
      hasChanges,
      previousMarket,
      updatedMarket,
      ticketJob: responseTicketJob,
      cancelledBooths,
      vendorChangedBooths: marketChanged
        ? plan.updated.map(({ current }) => ({
          id: current.id,
          boothCode: current.booth_code,
          boothName: current.booth_name,
        }))
        : [],
      addedBoothCodes: changes.Added,
      updatedBoothCodes,
      vendorLineTargetsByBoothCode:
        prepared?.vendorLineTargetsByBoothCode ?? new Map<string, VendorLineTargetDto[]>(),
      cancelledAssignments,
      teamScan,
      wasTeamReady: teamScanBefore.is_ready,
      workersRequiredChanged: finalTicketJob.workers_required !== ticketJob.workers_required,
      completedTicketJob,
    };
  });

  if (result.hasChanges) {
    await publishGateTicketUpdatedSideEffects(result, input.GateNo);
  }

  return result.response;
}

// Function ทำงานหลัง commit การแก้ไขตั๋ว (คืนคนเกิน แจ้ง Driver/Admin/Worker/LINE และหาคนเพิ่ม)
async function publishGateTicketUpdatedSideEffects(
  result: {
    response: GateTicketUpdateResponse;
    previousMarket: MarketJobDto;
    updatedMarket: MarketJobDto;
    ticketJob: TicketJobDto;
    cancelledBooths: CancelledGateBooth[];
    vendorChangedBooths: CancelledGateBooth[];
    addedBoothCodes: string[];
    updatedBoothCodes: string[];
    vendorLineTargetsByBoothCode: Map<string, VendorLineTargetDto[]>;
    cancelledAssignments: TicketJobAssignmentDto[];
    teamScan: VehicleWorkReadinessDto;
    wasTeamReady: boolean;
    workersRequiredChanged: boolean;
    completedTicketJob: CompletedTicketJobResult | null;
  },
  gateNo: string
): Promise<void> {
  const { response, ticketJob, previousMarket } = result;
  const changes = response.Changes;
  const market = response.Markets[0];
  const requeuedWorkerIds = await requeueExcessGateAssignments(
    ticketJob,
    result.cancelledAssignments
  );

  publishDriverJobUpdate(
    ticketJob.id,
    result.completedTicketJob ? "DRIVER_JOB_TERMINAL" : "DRIVER_JOB_UPDATED"
  );

  // แจ้ง Worker ทุกคนที่ยังอยู่บนรถ (ไม่รวมคนที่ถูกยกเลิกเพราะคนเกิน) และ Admin ด้วย event เดียว
  const activeAssignments = await assignmentRepository.listActiveAssignmentsByTicketJob(ticketJob.id);
  const eventPayload = {
    // TICKET_UPDATED = Gate แก้ตั๋ว (PUT), TICKET_ADDED = Gate เพิ่มตั๋วให้รถเดิม (POST)
    changeType: "TICKET_UPDATED",
    ticketNumber: ticketJob.ticket_number,
    ticketNo: result.updatedMarket.ticket_no,
    gateNo,
    marketJobId: String(result.updatedMarket.id),
    marketCode: result.updatedMarket.marketCode,
    marketName: result.updatedMarket.marketName,
    previousMarketCode: previousMarket.marketCode,
    dropoffPoint: result.updatedMarket.dropoff_point,
    addedBoothCodes: changes.Added,
    updatedBoothCodes: changes.Updated,
    removedBoothCodes: changes.Removed,
    marketChanged: changes.MarketChanged,
    dropoffPointChanged: changes.DropoffPointChanged,
    ticketWorkersRequired: result.updatedMarket.workers_required,
    workersRequired: ticketJob.workers_required,
  };

  publishRealtimeEvent({
    type: "TICKET_JOB_UPDATED",
    title: "Ticket updated by Gate",
    message: `Ticket ${result.updatedMarket.ticket_no} was updated by Gate ${gateNo}.`,
    notification_params: eventPayload,
    payload: eventPayload,
    worker_payload: eventPayload,
    admin: true,
    worker_ids: [...new Set(activeAssignments.map((assignment) => assignment.worker_id))],
  });

  // แจ้งทีมเมื่อจำนวนคนเปลี่ยน (ไม่ประกาศ TEAM_READY ซ้ำถ้าทีมพร้อมอยู่ก่อนแล้ว)
  if (result.workersRequiredChanged || result.cancelledAssignments.length > 0) {
    try {
      await notifyTicketJobTeamScanReadiness(ticketJob, result.teamScan, {
        announceReady: !result.wasTeamReady,
      });
    } catch (error) {
      logger.error("Gate ticket was updated but team readiness notification failed.", {
        ticketJobId: ticketJob.id,
        ticketNumber: ticketJob.ticket_number,
        error,
      });
    }
  }

  // ย้ายตลาด = Vendor ของแผงเปลี่ยนตามตลาดใหม่ แผงเดิมจึงแจ้งยกเลิกถึง Vendor ตลาดเดิม แล้วแจ้งลงสินค้าถึง Vendor ตลาดใหม่
  const vendorChangedBoothCodes = new Set(result.vendorChangedBooths.map((booth) => booth.boothCode));
  const cancelledNotifications = [...result.cancelledBooths, ...result.vendorChangedBooths];

  // แจ้งยกเลิกก่อนแจ้งลงสินค้าเสมอ
  for (const booth of cancelledNotifications) {
    await notifyVendorBoothCancelled({
      ticketId: booth.id,
      ticketNo: previousMarket.ticket_no,
      marketCode: previousMarket.marketCode,
      marketName: previousMarket.marketName,
      boothCode: booth.boothCode,
      boothName: booth.boothName,
      licensePlate: ticketJob.license_plate,
    });
  }

  const boothsByCode = new Map(market.Booths.map((booth) => [booth.BoothCode, booth]));
  const pickBooths = (boothCodes: Iterable<string>) =>
    [...boothCodes]
      .map((boothCode) => boothsByCode.get(boothCode))
      .filter((booth): booth is BoothJobJobResponseBooth => booth !== undefined);

  try {
    // แผงเดิมที่แก้สินค้า (Vendor เดิม) ได้ข้อความแก้ไขรายการ ไม่ใช่ยกเลิก
    await notifyVendorBoothJobCreated(
      response,
      market,
      pickBooths(result.updatedBoothCodes.filter((boothCode) => !vendorChangedBoothCodes.has(boothCode))),
      result.vendorLineTargetsByBoothCode,
      "updated"
    );
    await notifyVendorBoothJobCreated(
      response,
      market,
      pickBooths([...result.addedBoothCodes, ...vendorChangedBoothCodes]),
      result.vendorLineTargetsByBoothCode,
      "created"
    );
  } catch (error) {
    logger.error("Gate ticket was updated but vendor notification failed.", {
      ticketJobId: ticketJob.id,
      ticketNumber: ticketJob.ticket_number,
      error,
    });
  }

  await handleTicketJobClosedByCascadeCancellation(result.completedTicketJob);

  // หาคนเพิ่มให้รถคันนี้ และให้คนที่กลับเข้าคิวไปรับงานคันอื่น ตามลำดับคิวงาน (best-effort)
  try {
    if (requeuedWorkerIds.length > 0 || ticketJob.status === VEHICLE_JOB_STATUS.WORKING) {
      await dispatchReadyWorkers();
    }
  } catch (error) {
    logger.error("Gate ticket was updated but worker dispatch failed.", {
      ticketJobId: ticketJob.id,
      ticketNumber: ticketJob.ticket_number,
      error,
    });
  }
}
