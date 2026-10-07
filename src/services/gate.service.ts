// Import Library
import { createHash } from "crypto";
import { Prisma, type MasterMarket } from "@prisma/client";
// Import Config
import { TERMINAL_JOB_STATUSES, TICKET_STATUS, VEHICLE_JOB_STATUS } from "../constants/status";
import { getDriverWebBaseUrl } from "../config/driver.config";
import { withTransaction } from "../db/prisma";
// Import Repositories
import * as gateRepository from "../repositories/gate.repository";
import * as marketJobRepository from "../repositories/shared/market-job.repository";
// Import Services
import { publishNotification } from "./notifications.service";
import * as rateResolutionService from "./shared/rate-resolution.service";
// Import Queues
import { enqueueLoggedLineMessage } from "../queues/line-message-queue";
import { dispatchReadyWorkers } from "../queues/worker-dispatch";
// Import Types
import type { GateOptionsResponse, GateProductOption, BoothJobJobBody, BoothJobJobCreateInput, BoothJobJobResponse, BoothJobJobResponseStatus, BoothJobJobResult } from "../types/gate.type";
import type { DbConnection } from "../types/shared/common.type";
import type { LineMessage } from "../types/line.type";
import type { MarketJobDto, TicketJobDto, VendorLineTargetDto } from "../types/worker.type";
// Import Validation
import { parseWithSchema } from "../validation/parser";
import { boothJobJobBodySchema } from "../validation/schemas";
// Import Utils
import ApiError from "../utils/api-error";
import { calculateRequiredWorkerCount, packageWeightToDecimal, parseMasterProductRange } from "../utils/labor-job-pricing";
import { logger } from "../utils/logger";
import { buildBoothJobCreatedFlexMessage } from "../utils/line-flex-message";

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

// Type ข้อมูล Business Ticket ที่เตรียมแล้วพร้อมตลาด แผง และจำนวน worker
type LaborJobPreparation = {
  market: {
    marketCode: string;
    marketName: string;
  };

  booths: LaborBoothPreparation[];

  // จำนวน Worker สำหรับ Dispatch
  workerCount: number;
};

/* -------------------------------------- Functions -------------------------------------- */

// Config status ที่คืนให้ Gate เท่านั้น แยกจาก VEHICLE_OPERATION_STATUS ของ Admin Ops Board โดยตั้งใจ
const GATE_TICKET_RESPONSE_STATUS = {
  UNLOAD_NOW: "unload_now",
  WAITING_UNLOAD: "waiting_unload",
} as const;

// Function สร้าง status ที่คืนให้ Gate
function buildBoothJobResponseStatus(
  dispatch: boolean
): BoothJobJobResponseStatus {
  return dispatch
    ? GATE_TICKET_RESPONSE_STATUS.UNLOAD_NOW
    : GATE_TICKET_RESPONSE_STATUS.WAITING_UNLOAD;
}

// Function ตรวจว่าเป็น Gate response status หรือไม่
function isBoothJobResponseStatus(
  value: unknown
): value is BoothJobJobResponseStatus {
  return (
    value === GATE_TICKET_RESPONSE_STATUS.UNLOAD_NOW ||
    value === GATE_TICKET_RESPONSE_STATUS.WAITING_UNLOAD
  );
}

// Function ตรวจ Gate body สำหรับ replay
function isBoothJobJobBody(
  value: unknown
): value is BoothJobJobBody {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;

  if (
    typeof record.TicketNumber !== "string" ||
    typeof record.TicketNo !== "string" ||
    typeof record.TicketCreatedAt !== "string" ||
    typeof record.BoothCount !== "number" ||
    typeof record.MarketCode !== "string" ||
    typeof record.LicensePlate !== "string" ||
    typeof record.LicensePlateProvince !== "string" ||
    typeof record.VehicleTypeCode !== "string" ||
    typeof record.VehicleTypeName !== "string" ||
    !Array.isArray(record.Booths) ||
    typeof record.Dispatch !== "boolean"
  ) {
    return false;
  }

  return record.Booths.every((boothValue) => {
    if (!boothValue || typeof boothValue !== "object") {
      return false;
    }

    const booth = boothValue as Record<string, unknown>;

    if (
      typeof booth.BoothCode !== "string" ||
      !Array.isArray(booth.Products)
    ) {
      return false;
    }

    return booth.Products.every((productValue) => {
      if (!productValue || typeof productValue !== "object") {
        return false;
      }

      const product = productValue as Record<string, unknown>;

      return (
        typeof product.ProductCode === "string" &&
        typeof product.PackageCode === "string" &&
        typeof product.Quantity === "number"
      );
    });
  });
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

// Function ตรวจตลาด แผง และสินค้ากับ master data พร้อมหาจำนวน worker และ rate snapshot สำหรับงานจาก Gate
async function prepareLaborJob(
  input: BoothJobJobBody,
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
          id:
            product.id,

          productCode:
            product.productCode,

          productFullCode:
            product.productFullCode,

          productName:
            product.productName,

          packageCode:
            product.packageCode,

          packageName:
            product.packageName,

          quantity:
            productInput.Quantity,
        },

        requiredWorkerCount:
          workerRequirement
            .requiredWorkerCount,

        rateSnapshot: {
          rateId:
            applicableRate.rate.id,

          sourceRateId:
            applicableRate.rate
              .sourceRateId,

          requestedMarketCode:
            applicableRate
              .requestedMarketCode,

          appliedMarketCode:
            applicableRate
              .appliedMarketCode,

          rateSource:
            applicableRate.rateSource,

          packageWeight,

          weightRangeName:
            applicableRate.rate
              .weightRangeName,

          weightMin:
            applicableRate.rate
              .weightMin,

          weightMax:
            applicableRate.rate
              .weightMax,

          stallRate:
            applicableRate.rate
              .stallRate,

          laborRate:
            applicableRate.rate
              .laborRate,

          snapshotAt:
            rateSnapshotAt,
        },
      });
    }

    booths.push({
      boothCode:
        marketBooth.boothCode,

      boothName:
        marketBooth.boothName,

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

  // จำนวน worker ของ Ticket = ค่าสูงสุดของทุกสินค้าในทุกแผง (ไม่ใช่ผลรวม)
  const workerCount = Math.max(...workerCounts);

  return {
    market: {
      marketCode:
        input.MarketCode,

      marketName,
    },

    booths,

    workerCount,
  };
}

// Function สร้าง URL หน้า Driver Web โดยใส่ token ใน fragment (#token=) เพื่อไม่ให้ token ไปอยู่ใน log
function buildDriverQrUrl(driverQrToken: string): string {
  return `${getDriverWebBaseUrl()}/track#token=${encodeURIComponent(driverQrToken)}`;
}

// Function สร้าง response ที่คืนให้ Gate — เป็นข้อมูล Operation เท่านั้น ยังไม่มีเงินจริง
function buildPublicBoothJobJobResponse(
  ticketJob: TicketJobDto,
  marketJob: MarketJobDto,
  input: BoothJobJobBody,
  result: BoothJobJobResult,
  preparation: LaborJobPreparation
): BoothJobJobResponse {
  return {
    Result:
      result,

    TicketNumber:
      ticketJob.ticket_number,

    Ticket: {
      TicketNo:
        marketJob.ticket_no,

      TicketCreatedAt:
        marketJob.ticket_created_at,

      BoothCount:
        marketJob.booth_count,

      LicensePlate:
        ticketJob.license_plate,

      LicensePlateProvince:
        ticketJob.license_plate_province,

      VehicleTypeCode:
        input.VehicleTypeCode,

      VehicleTypeName:
        ticketJob.vehicle_type,

      Status:
        buildBoothJobResponseStatus(
          input.Dispatch
        ),
    },

    Market: {
      MarketCode:
        preparation.market.marketCode,

      MarketName:
        preparation.market.marketName,

      DropoffPoint:
        marketJob.dropoff_point,
    },

    Booths:
      preparation.booths.map(
        (booth) => ({
          BoothCode:
            booth.boothCode,

          BoothName:
            booth.boothName,

          Products:
            booth.products.map(
              (item) => ({
                ProductCode:
                  item.product
                    .productCode,

                ProductFullCode:
                  item.product
                    .productFullCode,

                ProductName:
                  item.product
                    .productName,

                PackageCode:
                  item.product
                    .packageCode,

                PackageName:
                  item.product
                    .packageName,

                Quantity:
                  item.product.quantity,

                // นี่คือ Master requirement ไม่ใช่จำนวนสำหรับหารเงินจริง
                WorkerCount:
                  item.requiredWorkerCount,
              })
            ),
        })
      ),

    // จำนวน Worker รวมทุก Business Ticket ของ TicketNumber นี้ที่ใช้ Dispatch
    WorkerCount:
      ticketJob.workers_required,

    Qr: {
      DriverQrToken:
        ticketJob.driver_qr_token,

      DriverQrUrl:
        buildDriverQrUrl(ticketJob.driver_qr_token),
    },
  };
}

// Function สร้างข้อความ LINE ของแต่ละแผง
function buildBoothJobCreatedMessages(
  response: BoothJobJobResponse,
  booth: BoothJobJobResponse["Booths"][number]
): LineMessage[] {
  return [
    buildBoothJobCreatedFlexMessage(
      response,
      booth
    ),
  ];
}

// Function แจ้ง LINE Vendor ของแต่ละแผงว่ามีงานใหม่
async function notifyVendorBoothJobCreated(
  response: BoothJobJobResponse,
  vendorLineTargetsByBoothCode: Map<string, VendorLineTargetDto[]>
): Promise<void> {
  for (const booth of response.Booths) {
    const vendorLineTargets =
      vendorLineTargetsByBoothCode.get(booth.BoothCode) ?? [];

    if (vendorLineTargets.length === 0) {
      continue;
    }

    const messages =
      buildBoothJobCreatedMessages(
        response,
        booth
      );

    const firstProduct =
      booth.Products[0];

    for (const target of vendorLineTargets) {
      await enqueueLoggedLineMessage({
        jobName:
          "send-gate-ticket-created",

        action:
          "send_gate_ticket_created",

        targetLineUserId:
          target.line_user_id,

        payload: {
          ticketNumber:
            response.TicketNumber,

          ticketNo:
            response.Ticket.TicketNo,

          marketCode:
            response.Market.MarketCode,

          boothCode:
            booth.BoothCode,

          productCode:
            firstProduct?.ProductCode ?? "",

          vendor_line_id:
            target.line_user_id,

          vendor_line_target_type:
            target.target_type,

          status:
            response.Ticket.Status,
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

// Function สร้างข้อมูลก่อนบันทึก TicketJob
function buildGateCreateInput(
  input: BoothJobJobBody,
  gateTransactionRef: string,
  preparation: LaborJobPreparation,
  existingMarketJobId?: number
): BoothJobJobCreateInput {
  return {
    ticketNumber:
      input.TicketNumber,

    license_plate:
      input.LicensePlate,

    license_plate_province:
      input.LicensePlateProvince,

    vehicle_type:
      input.VehicleTypeName,

    dispatch_now:
      input.Dispatch,

    existingMarketJobId,

    markets: [
      {
        ticketNo:
          input.TicketNo,

        ticket_created_at:
          new Date(
            input.TicketCreatedAt
          ),

        booth_count:
          input.BoothCount,

        gate_transaction_ref:
          gateTransactionRef,

        workers_required:
          preparation.workerCount,

        marketCode:
          preparation.market
            .marketCode,

        marketName:
          preparation.market
            .marketName,

        dropoff_point:
          input.DropoffPoint,

        booths:
          preparation.booths.map(
            (booth) => ({
              boothCode:
                booth.boothCode,

              boothName:
                booth.boothName,

              products:
                booth.products.map(
                  (item) => ({
                    productCode:
                      item.product
                        .productCode,

                    productName:
                      item.product
                        .productName,

                    productFullCode:
                      item.product
                        .productFullCode,

                    packageCode:
                      item.product
                        .packageCode,

                    packageName:
                      item.product
                        .packageName,

                    quantity:
                      item.product
                        .quantity,

                    packageWeightSnapshot:
                      item.rateSnapshot
                        .packageWeight
                        .toString(),

                    rateIdSnapshot:
                      item.rateSnapshot
                        .rateId,

                    sourceRateIdSnapshot:
                      item.rateSnapshot
                        .sourceRateId,

                    rateMarketCode:
                      item.rateSnapshot
                        .appliedMarketCode,

                    rateSource:
                      item.rateSnapshot
                        .rateSource,

                    weightRangeName:
                      item.rateSnapshot
                        .weightRangeName,

                    weightMinSnapshot:
                      item.rateSnapshot
                        .weightMin
                        .toString(),

                    weightMaxSnapshot:
                      item.rateSnapshot
                        .weightMax
                        .toString(),

                    stallRateSnapshot:
                      item.rateSnapshot
                        .stallRate
                        .toString(),

                    laborRateSnapshot:
                      item.rateSnapshot
                        .laborRate
                        .toString(),

                    rateSnapshotAt:
                      item.rateSnapshot
                        .snapshotAt,
                  })
                ),
            })
          ),
      },
    ],
  };
}

// Function เติม Vendor LINE ID ให้แต่ละแผง และคืน LINE target ไว้ใช้แจ้งเตือนต่อ
async function buildGateCreateInputWithVendorLineIds(
  input: BoothJobJobCreateInput,
  connection?: DbConnection
): Promise<{
  input: BoothJobJobCreateInput;
  vendorLineTargetsByBoothCode: Map<string, VendorLineTargetDto[]>;
}> {
  const vendorLineTargetsByBoothCode = new Map<string, VendorLineTargetDto[]>();
  const markets =
    await Promise.all(
      input.markets.map(
        async (market) => ({
          ...market,

          booths:
            await Promise.all(
              market.booths.map(
                async (booth) => {
                  const vendorLineTargets =
                    await gateRepository.listActiveVendorLineTargetsByStall(
                      market.marketCode,
                      booth.boothCode,
                      connection
                    );

                  if (
                    vendorLineTargets.length === 0
                  ) {
                    throw new ApiError(
                      409,
                      "BOOTH_VENDOR_LINE_NOT_CONFIGURED",
                      "Booth vendor LINE id is not configured in vendor master mapping.",
                      {
                        marketCode:
                          market.marketCode,

                        boothCode:
                          booth.boothCode,
                      }
                    );
                  }

                  vendorLineTargetsByBoothCode.set(
                    booth.boothCode,
                    vendorLineTargets
                  );

                  return {
                    ...booth,

                    vendor_line_id:
                      vendorLineTargets[0]
                        .line_user_id,
                  };
                }
              )
            ),
        })
      )
    );

  return {
    input: {
      ...input,
      markets,
    },
    vendorLineTargetsByBoothCode,
  };
}

// Function สร้างหรือเพิ่ม Business Ticket เข้างานรถจาก Gate (ลำดับ lock ห้ามสลับ เพราะกัน Gate ยิงซ้ำพร้อมกัน)
export async function createOrAppendGateBusinessTicket(
  input: BoothJobJobCreateInput,
  payloadSnapshot: Prisma.InputJsonValue,
  connection?: DbConnection
): Promise<{ ticketJob: TicketJobDto; marketJob: MarketJobDto }> {
  const market = input.markets[0];
  const dispatchNow = input.dispatch_now;
  const vehicleStatus = dispatchNow ? VEHICLE_JOB_STATUS.WORKING : VEHICLE_JOB_STATUS.WAIT;
  const ticketStatus = TICKET_STATUS.WAIT;
  const requestedWorkersRequired = Math.max(1, market.workers_required);

  // Lock TicketJob ก่อนสร้างหรือ append Business Ticket
  const existingTicketJob = await gateRepository.lockAndFindTicketJobByRef(
    input.ticketNumber,
    connection
  );

  const ticketJob =
    existingTicketJob ??
    (await gateRepository.createTicketJob(
      {
        ticketNumber: input.ticketNumber,
        licensePlate: input.license_plate,
        licensePlateProvince: input.license_plate_province,
        vehicleType: input.vehicle_type,
        workersRequired: requestedWorkersRequired,
        dispatchNow,
        status: vehicleStatus,
      },
      connection
    ));

  // เปิด dispatch คืนเมื่อ Gate เพิ่ม booth หลัง release-workers
  const canReopenDispatch =
    existingTicketJob?.status === VEHICLE_JOB_STATUS.WAIT ||
    existingTicketJob?.status === VEHICLE_JOB_STATUS.RELEASED;
  // รถที่ปิดไปแล้วได้ Business Ticket ใหม่ ต้องเปิดรถกลับมาทำงาน ไม่งั้นจะไม่มีการหาคน
  const isReopeningTerminalVehicle =
    existingTicketJob !== null &&
    TERMINAL_JOB_STATUSES.includes(existingTicketJob.status);
  const shouldUpdateVehicle =
    existingTicketJob !== null &&
    (isReopeningTerminalVehicle ||
      existingTicketJob.license_plate !== input.license_plate ||
      existingTicketJob.license_plate_province !== input.license_plate_province ||
      existingTicketJob.vehicle_type !== input.vehicle_type ||
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

  // Re-check MarketJob หลัง lock ก่อน append
  const existingMarket = input.existingMarketJobId
    ? await gateRepository.lockAndFindMarketJobById(input.existingMarketJobId, connection)
    : null;

  const savedMarket =
    existingMarket && existingMarket.status !== VEHICLE_JOB_STATUS.CANCELLED
      ? // Gate ส่งแผงชุดใหม่เข้า Ticket เดิม (TicketNo + ตลาดเดิม ยัง active) — boothCount บวกเพิ่มเฉพาะแผงใหม่
      // workersRequired ใช้ MAX ระหว่างของเดิมกับคำขอนี้ (แผงเดิมไม่ถูกแตะ ไม่ต้องคำนวณใหม่จากศูนย์)
      await gateRepository.appendMarketJobBooths(
        existingMarket.id,
        {
          boothCountIncrement: market.booth_count,
          workersRequired: Math.max(existingMarket.workers_required, requestedWorkersRequired),
          gateTransactionRef: market.gate_transaction_ref,
        },
        connection
      )
      : await gateRepository.createMarketJob(
        {
          ticketJobId: savedTicketJob.id,
          ticketNo: market.ticketNo,
          ticketCreatedAt: market.ticket_created_at,
          boothCount: market.booth_count,
          gateTransactionRef: market.gate_transaction_ref,
          workersRequired: requestedWorkersRequired,
          marketCode: market.marketCode,
          marketName: market.marketName,
          dropoffPoint: market.dropoff_point,
          status: marketStatus,
        },
        connection
      );

  await gateRepository.createBoothJobsWithProducts(
    savedTicketJob.id,
    savedMarket.id,
    market.booths,
    ticketStatus,
    connection
  );

  // จำนวน worker ของงานรถ = ผลรวมของทุก Business Ticket ที่ยัง active
  const workersRequiredSum = await gateRepository.sumActiveMarketJobWorkersRequired(
    savedTicketJob.id,
    connection
  );
  const totalWorkersRequired = workersRequiredSum ?? requestedWorkersRequired;

  // ปิดรับ Ticket เพิ่มหลัง Gate create สำเร็จ
  const ticketsClosedAt = savedTicketJob.tickets_closed_at
    ? new Date(savedTicketJob.tickets_closed_at)
    : new Date();

  const ticketCount = await gateRepository.countActiveMarketJobs(savedTicketJob.id, connection);

  const finalTicketJob = await gateRepository.finalizeTicketJob(
    savedTicketJob.id,
    {
      workersRequired: totalWorkersRequired,
      expectedTicketCount: ticketCount,
      ticketsClosedAt,
    },
    connection
  );

  await gateRepository.createGateRequestLog(
    {
      gateTransactionRef: market.gate_transaction_ref,
      ticketJobId: finalTicketJob.id,
      marketJobId: savedMarket.id,
      payloadSnapshot,
    },
    connection
  );

  return {
    ticketJob: finalTicketJob,
    marketJob: savedMarket,
  };
}

// Function สร้าง response เมื่อ Gate ส่ง request เดิม
function buildGateReplayResponse(
  response: BoothJobJobResponse,
  payloadSnapshot: unknown
): BoothJobJobResponse {
  const responseRecord =
    response as unknown as Record<
      string,
      unknown
    >;

  if (
    !("Ticket" in responseRecord) ||
    !("Market" in responseRecord) ||
    !("Booths" in responseRecord)
  ) {
    throw new ApiError(
      409,
      "GATE_REQUEST_RESPONSE_NOT_READY",
      "Gate request already exists but its response snapshot is not ready."
    );
  }

  const status =
    isBoothJobJobBody(payloadSnapshot)
      ? buildBoothJobResponseStatus(
        payloadSnapshot.Dispatch
      )
      : isBoothJobResponseStatus(
        response.Ticket.Status
      )
        ? response.Ticket.Status
        : GATE_TICKET_RESPONSE_STATUS.WAITING_UNLOAD;

  return {
    ...response,

    Result:
      "REPLAYED",

    Ticket: {
      ...response.Ticket,
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

// Function สร้าง TicketJob จาก Gate
export async function createTicketJobFromGate(
  body: unknown
): Promise<BoothJobJobResponse> {
  const input =
    parseWithSchema<BoothJobJobBody>(
      boothJobJobBodySchema,
      body
    );

  const gateTransactionRef =
    buildGateTransactionRef(input);

  const existingGateRequest =
    await gateRepository.findGateRequestReplayByRef(
      gateTransactionRef
    );

  // คืน response เดิมเมื่อ Request เดิมถูกส่งซ้ำ
  if (existingGateRequest) {
    if (
      !arePayloadsEqual(
        existingGateRequest.payload_snapshot,
        input
      )
    ) {
      logger.warn(
        "Gate request payload mismatch",
        {
          gate_transaction_ref:
            existingGateRequest
              .gate_transaction_ref,

          ticketNo:
            input.TicketNo,
        }
      );

      throw new ApiError(
        409,
        "GATE_TRANSACTION_REF_PAYLOAD_MISMATCH",
        "gate_transaction_ref already exists with a different payload.",
        {
          duplicate_field:
            "gate_transaction_ref",

          gate_transaction_ref:
            existingGateRequest
              .gate_transaction_ref,
        }
      );
    }

    if (
      !existingGateRequest.response_snapshot
    ) {
      throw new ApiError(
        409,
        "GATE_REQUEST_RESPONSE_NOT_READY",
        "Gate request already exists but its response snapshot is not ready.",
        {
          duplicate_field:
            "gate_transaction_ref",

          gate_transaction_ref:
            existingGateRequest
              .gate_transaction_ref,
        }
      );
    }

    logger.info(
      "Gate request replayed",
      {
        gate_transaction_ref:
          existingGateRequest
            .gate_transaction_ref,

        ticketNo:
          input.TicketNo,
      }
    );

    return buildGateReplayResponse(
      existingGateRequest.response_snapshot,
      existingGateRequest.payload_snapshot
    );
  }

  // TicketNo ซ้ำที่ยัง active: ตลาดเดียวกันให้เพิ่มแผงเข้าใบเดิม ตลาดต่างกันให้ปฏิเสธ
  const existingTicketJob =
    await gateRepository.findTicketJobByRef(
      input.TicketNumber
    );

  let existingMarketJobId: number | undefined;

  if (existingTicketJob) {
    const existingMarketJob =
      await marketJobRepository.findMarketJobByVehicleAndTicketNo(
        existingTicketJob.id,
        input.TicketNo
      );

    if (existingMarketJob) {
      if (existingMarketJob.marketCode !== input.MarketCode) {
        throw new ApiError(
          409,
          "GATE_TICKET_ALREADY_EXISTS",
          "TicketNo already exists under this TicketNumber for a different market. Ask an Admin to cancel it first if this Ticket needs to be recreated.",
          {
            ticketNumber:
              input.TicketNumber,

            ticketNo:
              input.TicketNo,
          }
        );
      }

      if (existingMarketJob.worker_roster_locked_at) {
        throw new ApiError(
          409,
          "GATE_TICKET_ROSTER_LOCKED",
          "This Ticket's worker roster is already locked and can no longer accept new booths.",
          {
            ticketNumber:
              input.TicketNumber,

            ticketNo:
              input.TicketNo,
          }
        );
      }

      const existingBoothCodes =
        await gateRepository.listBoothJobBoothCodesByMarketJobId(
          existingMarketJob.id
        );
      const duplicateBoothCode = input.Booths.find((booth) =>
        existingBoothCodes.includes(booth.BoothCode)
      );

      if (duplicateBoothCode) {
        throw new ApiError(
          409,
          "GATE_BOOTH_ALREADY_EXISTS_IN_TICKET",
          `BoothCode ${duplicateBoothCode.BoothCode} already exists in this Ticket.`,
          {
            ticketNumber:
              input.TicketNumber,

            ticketNo:
              input.TicketNo,

            boothCode:
              duplicateBoothCode.BoothCode,
          }
        );
      }

      existingMarketJobId = existingMarketJob.id;
    }
  }

  const createResult =
    await withTransaction(
      async (transaction) => {
        // Resolve Master + Worker requirement และ Snapshot Rate (ยังไม่คำนวณเงินจริง)
        const preparation =
          await prepareLaborJob(
            input,
            transaction
          );

        // สร้างข้อมูลสำหรับบันทึก DB
        const gateInput =
          buildGateCreateInput(
            input,
            gateTransactionRef,
            preparation,
            existingMarketJobId
          );

        // เติม LINE ID ของแต่ละแผง
        const {
          input: gateInputWithVendorLineIds,
          vendorLineTargetsByBoothCode,
        } =
          await buildGateCreateInputWithVendorLineIds(
            gateInput,
            transaction
          );

        // สร้าง TicketJob (ถ้ายังไม่มี) และ Business Ticket ใหม่
        const { ticketJob, marketJob } =
          await createOrAppendGateBusinessTicket(
            gateInputWithVendorLineIds,
            input as unknown as Prisma.InputJsonValue,
            transaction
          );

        // สร้าง response จากผลการสร้างโดยตรง ไม่ต้อง reload
        const response =
          buildPublicBoothJobJobResponse(
            ticketJob,
            marketJob,
            input,
            "CREATED",
            preparation
          );

        // เก็บ response สำหรับ replay
        await gateRepository.updateGateRequestResponse(
          gateTransactionRef,
          response as unknown as Prisma.InputJsonValue,
          transaction
        );

        return {
          dispatch_vehicle_job_id:
            gateInputWithVendorLineIds
              .dispatch_now === true
              ? ticketJob.id
              : null,

          response,
          vendorLineTargetsByBoothCode,
        };
      }
    ).catch(async (error) => {
      // BoothCode ชนกันจาก Gate ยิงซ้ำพร้อมกัน แปลงเป็น ApiError (อ่าน field ทั้งจาก meta.target และ driver adapter)
      const targetFromMeta =
        error instanceof Prisma.PrismaClientKnownRequestError
          ? error.meta?.target
          : undefined;
      // adapter-pg >= 7.10 ส่งชื่อ index แทน fields เมื่อ Postgres ระบุ constraint มา
      const constraintFromDriverAdapter =
        error instanceof Prisma.PrismaClientKnownRequestError
          ? (error.meta?.driverAdapterError as { cause?: { constraint?: { fields?: string[]; index?: string } } } | undefined)
              ?.cause?.constraint
          : undefined;
      const targetFromDriverAdapter =
        constraintFromDriverAdapter?.fields ?? constraintFromDriverAdapter?.index;
      const targetText = (
        Array.isArray(targetFromMeta)
          ? targetFromMeta.join(",")
          : Array.isArray(targetFromDriverAdapter)
            ? targetFromDriverAdapter.join(",")
            : String(targetFromMeta ?? targetFromDriverAdapter ?? "")
      ).toLowerCase();
      const isDuplicateBoothCode =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002" &&
        targetText.includes("booth");

      if (isDuplicateBoothCode) {
        throw new ApiError(
          409,
          "GATE_BOOTH_ALREADY_EXISTS_IN_TICKET",
          "One or more BoothCodes already exist in this Ticket.",
          {
            ticketNumber: input.TicketNumber,
            ticketNo: input.TicketNo,
          }
        );
      }

      // ticketNumber/ticketNo ชนกันจาก request พร้อมกัน ให้อ่าน replay ใหม่แล้วคืน response เดิม
      const isDuplicateTicketIdentity =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002" &&
        (targetText.includes("ticket_number") || targetText.includes("ticket_no"));

      if (isDuplicateTicketIdentity) {
        const replay =
          await gateRepository.findGateRequestReplayByRef(gateTransactionRef);

        if (replay?.response_snapshot) {
          return {
            dispatch_vehicle_job_id: null,
            response: buildGateReplayResponse(
              replay.response_snapshot,
              replay.payload_snapshot
            ),
            vendorLineTargetsByBoothCode: new Map<string, VendorLineTargetDto[]>(),
          };
        }
      }

      throw error;
    });

  const response =
    createResult.response;

  // เรียก Worker เมื่อ Dispatch = true
  if (
    createResult.dispatch_vehicle_job_id !==
    null
  ) {
    try {
      await dispatchReadyWorkers(
        undefined,
        {
          vehicle_job_ids: [
            createResult
              .dispatch_vehicle_job_id,
          ],
        }
      );
    } catch (error) {
      logger.error("Gate ticket was created but worker dispatch failed.", {
        error,
      });
    }
  }

  // แจ้ง Admin ว่ามีงานใหม่
  publishNotification({
    type:
      "VEHICLE_JOB_CREATED",

    title:
      "Vehicle job created",

    message:
      `Vehicle job ${response.Ticket.TicketNo} was created from Gate.`,

    payload: {
      ticketNumber:
        response.TicketNumber,

      ticketNo:
        response.Ticket.TicketNo,

      gate_transaction_ref:
        gateTransactionRef,

      license_plate:
        response.Ticket.LicensePlate,

      license_plate_province:
        response.Ticket.LicensePlateProvince,

      status:
        response.Ticket.Status,

      dispatch_now:
        input.Dispatch === true,
    },

    audience: {
      roles: ["admin"],
    },
  });

  // แจ้ง Vendor ของแต่ละแผง
  try {
    await notifyVendorBoothJobCreated(
      response,
      createResult.vendorLineTargetsByBoothCode
    );
  } catch (error) {
    logger.error("Gate ticket was created but vendor notification failed.", {
      error,
    });
  }

  return response;
}

