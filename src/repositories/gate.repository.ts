// Import Library
import { Prisma, type MasterMarket } from "@prisma/client";
// Import Config
import { MASTER_MARKET_ACTIVE_STATUS, MASTER_OWNER_STALL_ACTIVE_STATUS, TICKET_STATUS, VEHICLE_JOB_STATUS } from "../constants/status";
// Import Repositories
import * as boothJobRepository from "./shared/booth-job.repository";
import { syncTicketJobDispatchReadyAt } from "./shared/ticket-job.repository";
import { client, createRandomToken, requireDto } from "./shared/repository-utils";
// Import Mappers
import { mapMarketJob, mapTicketJob } from "./shared/mappers";
// Import Types
import type { DbConnection } from "../types/shared/common.type";
import type { GateRequestReplayRecord, BoothJobJobResponse, GateBoothCreateInput, GateBoothOption, GateProductCreateInput, GateTicketBoothRecord } from "../types/gate.type";
import type { MarketJobDto, TicketJobDto, VendorLineTargetDto } from "../types/worker.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function ตรวจว่าตลาด+แผงใน master_market ยังใช้งานได้ (boothStatus = Normal, marketStatus = null/Normal)
function isActiveMasterMarketBooth(record: {
  boothStatus: string;
  marketStatus: string | null;
}): boolean {
  return (
    record.boothStatus === MASTER_MARKET_ACTIVE_STATUS &&
    (record.marketStatus === null || record.marketStatus === MASTER_MARKET_ACTIVE_STATUS)
  );
}

// Function สร้าง where กรองเฉพาะ master_market ที่ใช้งานได้
function activeMasterMarketWhere(): {
  boothStatus: string;
  OR: Array<{ marketStatus: string | null }>;
} {
  return {
    boothStatus: MASTER_MARKET_ACTIVE_STATUS,
    OR: [{ marketStatus: null }, { marketStatus: MASTER_MARKET_ACTIVE_STATUS }],
  };
}

// Function ค้นหา gate request replay ตาม ref จาก DB
export async function findGateRequestReplayByRef(
  gateTransactionRef: string,
  connection?: DbConnection
): Promise<GateRequestReplayRecord | null> {
  const db = client(connection);
  const requestLog = await db.gateRequestLog.findUnique({
    where: {
      gateTransactionRef,
    },
  });

  if (!requestLog) {
    return null;
  }

  return {
    gate_transaction_ref: requestLog.gateTransactionRef,
    payload_snapshot: requestLog.payloadSnapshot,
    response_snapshot: requestLog.responseSnapshot as unknown as BoothJobJobResponse | null,
  };
}

// Function ค้นหางานรถตาม TicketNumber
export async function findTicketJobByRef(
  ticketNumber: string,
  connection?: DbConnection
): Promise<TicketJobDto | null> {
  const db = client(connection);
  const ticketJob = await db.ticketJob.findUnique({
    where: {
      ticketNumber,
    },
  });

  return mapTicketJob(ticketJob);
}

// Function ค้นหา active vendor LINE targets ตาม stall จาก DB
export async function listActiveVendorLineTargetsByStall(
  marketCode: string,
  boothCode: string,
  connection?: DbConnection
): Promise<VendorLineTargetDto[]> {
  return boothJobRepository.listActiveVendorLineTargetsByMarketAndBooth(
    marketCode,
    boothCode,
    connection
  );
}

// Function ดึงรายการตลาดที่พร้อมใช้ (TEST HELPER สำหรับ GET /api/gate/options)
export async function listGateMarketOptions(
  marketCode?: string,
  connection?: DbConnection
) {
  const db = client(connection);

  return db.masterMarket.findMany({
    where: {
      ...(marketCode
        ? {
          marketCode,
        }
        : {}),
      ...activeMasterMarketWhere(),
      marketName: {
        not: null,
      },
    },
    select: {
      marketCode: true,
      marketName: true,
    },
    distinct: ["marketCode"],
    orderBy: {
      marketCode: "asc",
    },
  });
}

// Function ดึงรายการแผงของตลาดที่มี Vendor LINE พร้อมใช้งาน (ใช้กับ GET /api/gate/options)
export async function listGateBoothOptionsByMarketCode(
  marketCode: string,
  connection?: DbConnection
): Promise<GateBoothOption[]> {
  const db = client(connection);

  const [marketBooths, vendorStalls] = await Promise.all([
    db.masterMarket.findMany({
      where: {
        marketCode,
        ...activeMasterMarketWhere(),
      },
      select: {
        boothCode: true,
        boothName: true,
      },
      orderBy: {
        boothCode: "asc",
      },
    }),

    db.masterOwnerStall.findMany({
      where: {
        marketCode,
        status: MASTER_OWNER_STALL_ACTIVE_STATUS,
        ownerStatus: MASTER_MARKET_ACTIVE_STATUS,
        lineUserId: {
          not: null,
        },
      },
      select: {
        boothCode: true,
      },
    }),
  ]);

  const configuredBoothCodes = new Set(
    vendorStalls.map((stall) => stall.boothCode)
  );

  return marketBooths
    .filter((booth) =>
      configuredBoothCodes.has(booth.boothCode)
    )
    .map((booth) => ({
      BoothCode: booth.boothCode,
      BoothName: booth.boothName,
    }));
}

// Function ดึงรายการสินค้าและแพ็กเกจที่ยังใช้งานอยู่ (TEST HELPER สำหรับ GET /api/gate/options)
export async function listGateProductPackageOptions(
  connection?: DbConnection
) {
  const db = client(connection);

  return db.masterProduct.findMany({
    where: {
      status: "ACTIVE",
    },
    select: {
      productCode: true,
      productName: true,
      packageCode: true,
      packageName: true,
      packageWeight: true,
    },
    orderBy: [
      {
        productCode: "asc",
      },
      {
        packageCode: "asc",
      },
    ],
  });
}

// Function ค้นหา master_market (ตลาด+แผง) จาก marketCode + boothCode ที่ยังใช้งานอยู่
export async function findActiveMarketBoothByCodes(
  marketCode: string,
  boothCode: string,
  connection?: DbConnection
): Promise<MasterMarket | null> {
  const db = client(connection);
  const marketBooth = await db.masterMarket.findUnique({
    where: {
      marketCode_boothCode: {
        marketCode,
        boothCode,
      },
    },
  });

  if (!marketBooth || !isActiveMasterMarketBooth(marketBooth)) {
    return null;
  }

  return marketBooth;
}

// Function lock TicketJob ตาม TicketNumber แล้วอ่านแถวล่าสุด (กัน Gate ยิงซ้ำพร้อมกัน)
export async function lockAndFindTicketJobByRef(
  ticketNumber: string,
  connection?: DbConnection
): Promise<TicketJobDto | null> {
  const db = client(connection);

  await db.$queryRaw`SELECT id FROM ticket_jobs WHERE ticket_number = ${ticketNumber} FOR UPDATE`;

  const ticketJob = await db.ticketJob.findUnique({
    where: {
      ticketNumber,
    },
  });

  return mapTicketJob(ticketJob);
}

// Function สร้าง TicketJob ใหม่จาก payload ของ Gate
export async function createTicketJob(
  data: {
    ticketNumber: string;
    licensePlate: string;
    licensePlateProvince: string;
    vehicleType: string | null;
    vehicleTypeCode: string | null;
    workersRequired: number;
    dispatchNow: boolean;
    status: string;
  },
  connection?: DbConnection
): Promise<TicketJobDto> {
  const db = client(connection);
  const ticketJob = await db.ticketJob.create({
    data: {
      ...data,
      driverQrToken: createRandomToken("driver_qr"),
      // สร้างพร้อม Dispatch = true ถือว่าพร้อมจ่ายงานตั้งแต่ตอนสร้าง
      dispatchReadyAt: data.status === VEHICLE_JOB_STATUS.WORKING ? new Date() : null,
    },
  });

  return requireDto(mapTicketJob(ticketJob), "vehicle job create");
}

// Function อัปเดตรายละเอียด TicketJob ที่มีอยู่แล้ว (ทะเบียน/ประเภทรถ/dispatch/status)
export async function updateTicketJobDetails(
  ticketJobId: number,
  data: {
    licensePlate: string;
    licensePlateProvince: string;
    vehicleType: string | null;
    vehicleTypeCode: string | null;
    dispatchNow: boolean;
    status: string;
  },
  connection?: DbConnection
): Promise<TicketJobDto> {
  const db = client(connection);
  const ticketJob = await db.ticketJob.update({
    where: {
      id: ticketJobId,
    },
    data,
  });

  await syncTicketJobDispatchReadyAt(ticketJobId, connection);

  return requireDto(mapTicketJob(ticketJob), "vehicle job update");
}

// Function lock MarketJob แล้วอ่านแถวล่าสุดก่อนเพิ่มแผง (throw ถ้าไม่พบ)
export async function lockAndFindMarketJobById(
  marketJobId: number,
  connection?: DbConnection
): Promise<MarketJobDto> {
  const db = client(connection);

  await db.$queryRaw`SELECT id FROM market_jobs WHERE id = ${marketJobId} FOR UPDATE`;

  const marketJob = await db.marketJob.findUniqueOrThrow({
    where: {
      id: marketJobId,
    },
  });

  return requireDto(mapMarketJob(marketJob), "market job lookup");
}

// Function อัปเดตตลาด จำนวนแผง จำนวน Worker และจุดลงสินค้าของ Business Ticket เดิมหลัง Gate แก้ไขตั๋ว (id/TicketNo คงเดิม)
export async function updateMarketJobAfterGateEdit(
  marketJobId: number,
  data: {
    marketCode: string;
    marketName: string;
    boothCount: number;
    workersRequired: number;
    dropoffPoint: string;
  },
  connection?: DbConnection
): Promise<MarketJobDto> {
  const db = client(connection);
  const marketJob = await db.marketJob.update({
    where: {
      id: marketJobId,
    },
    data,
  });

  return requireDto(mapMarketJob(marketJob), "market job gate update");
}

// Function ค้นหา Business Ticket ที่ยังไม่ถูกยกเลิกจาก TicketNo (อาจมีมากกว่า 1 ใบถ้า TicketNo ซ้ำข้ามรถ)
export async function listActiveMarketJobsByTicketNo(
  ticketNo: string,
  connection?: DbConnection
): Promise<MarketJobDto[]> {
  const db = client(connection);
  const marketJobs = await db.marketJob.findMany({
    where: {
      ticketNo,
      status: { not: VEHICLE_JOB_STATUS.CANCELLED },
    },
    orderBy: {
      id: "asc",
    },
  });

  return marketJobs.map((marketJob) => requireDto(mapMarketJob(marketJob), "market job lookup"));
}

// Function lock แผงที่ยังไม่ถูกยกเลิกของ Business Ticket แล้วอ่านพร้อมสินค้า (กัน race กับ Worker ส่งยอด)
export async function lockAndListGateTicketBooths(
  marketJobId: number,
  connection?: DbConnection
): Promise<GateTicketBoothRecord[]> {
  const db = client(connection);

  await db.$queryRaw`SELECT id FROM booth_jobs WHERE market_job_id = ${marketJobId} AND status <> 'CANCELLED' ORDER BY id FOR UPDATE`;

  return listGateTicketBooths(marketJobId, connection);
}

// Function ตรวจว่า Business Ticket เคยมีแผงถูกส่งยอดแล้วหรือไม่ (นับแผงที่ถูกยกเลิกหลัง Reject ด้วย)
export async function hasTicketCompletionSubmissionForMarketJob(
  marketJobId: number,
  connection?: DbConnection
): Promise<boolean> {
  const db = client(connection);
  const count = await db.ticketCompletionSubmission.count({
    where: {
      ticket: {
        marketJobId,
      },
    },
  });

  return count > 0;
}

// Function ดึงแผงที่ยังไม่ถูกยกเลิกของ Business Ticket พร้อมสินค้า
export async function listGateTicketBooths(
  marketJobId: number,
  connection?: DbConnection
): Promise<GateTicketBoothRecord[]> {
  const db = client(connection);
  const booths = await db.boothJob.findMany({
    where: {
      marketJobId,
      status: { not: TICKET_STATUS.CANCELLED },
    },
    include: {
      products: {
        orderBy: {
          id: "asc",
        },
      },
    },
    orderBy: {
      id: "asc",
    },
  });

  return booths.map((booth) => ({
    id: booth.id,
    booth_code: booth.boothCode,
    booth_name: booth.boothName,
    status: booth.status,
    products: booth.products.map((product) => ({
      id: product.id,
      product_code: product.productCode,
      product_full_code: product.productFullCode,
      product_name: product.productName,
      package_code: product.packageCode,
      package_name: product.packageName,
      quantity: product.quantity.toNumber(),
      required_worker_count: product.requiredWorkerCountSnapshot,
    })),
  }));
}

// Function สร้าง MarketJob (Business Ticket) ใหม่ใต้ TicketJob ที่ระบุ
export async function createMarketJob(
  data: {
    ticketJobId: number;
    ticketNo: string;
    ticketCreatedAt: Date;
    boothCount: number;
    gateTransactionRef: string;
    workersRequired: number;
    marketCode: string;
    marketName: string;
    dropoffPoint: string | null;
    gateNo: string | null;
    gateClientId: number | null;
    status: string;
  },
  connection?: DbConnection
): Promise<MarketJobDto> {
  const db = client(connection);
  const marketJob = await db.marketJob.create({
    data,
  });

  return requireDto(mapMarketJob(marketJob), "market job create");
}

// Function สร้าง BoothJob ของแต่ละแผงพร้อม TicketProduct (คืน id ของแผงที่สร้าง)
export async function createBoothJobsWithProducts(
  ticketJobId: number,
  marketJobId: number,
  booths: GateBoothCreateInput[],
  ticketStatus: string,
  connection?: DbConnection
): Promise<Array<{ id: number; boothCode: string }>> {
  const db = client(connection);
  const createdBooths: Array<{ id: number; boothCode: string }> = [];

  for (const booth of booths) {
    const createdTicket = await db.boothJob.create({
      data: {
        ticketJobId,
        marketJobId,
        boothCode: booth.boothCode,
        boothName: booth.boothName ?? null,
        vendorLineId: booth.vendor_line_id ?? null,
        rejectReason: booth.reject_reason ?? null,
        status: ticketStatus,
      },
    });
    const ticketId = createdTicket.id;

    createdBooths.push({ id: ticketId, boothCode: createdTicket.boothCode });

    await createTicketProducts(ticketId, booth.products, connection);
  }

  return createdBooths;
}

// Function แปลงสินค้าที่เตรียมแล้วเป็นข้อมูลบันทึก TicketProduct (จำนวน + จำนวนคน + rate snapshot)
function buildTicketProductData(product: GateProductCreateInput) {
  return {
    productCode: product.productCode,
    productFullCode: product.productFullCode,
    productName: product.productName,
    packageCode: product.packageCode,
    packageName: product.packageName,
    quantity: product.quantity,
    requiredWorkerCountSnapshot: product.requiredWorkerCount,
    packageWeightSnapshot: product.packageWeightSnapshot,
    rateIdSnapshot: product.rateIdSnapshot,
    sourceRateIdSnapshot: product.sourceRateIdSnapshot,
    rateMarketCode: product.rateMarketCode,
    rateSource: product.rateSource,
    weightRangeName: product.weightRangeName,
    weightMinSnapshot: product.weightMinSnapshot,
    weightMaxSnapshot: product.weightMaxSnapshot,
    stallRateSnapshot: product.stallRateSnapshot,
    laborRateSnapshot: product.laborRateSnapshot,
    rateSnapshotAt: product.rateSnapshotAt,
  };
}

// Function สร้าง TicketProduct ของแผงที่ระบุ
export async function createTicketProducts(
  boothJobId: number,
  products: GateProductCreateInput[],
  connection?: DbConnection
): Promise<void> {
  const db = client(connection);

  for (const product of products) {
    await db.ticketProduct.create({
      data: {
        ticketId: boothJobId,
        ...buildTicketProductData(product),
      },
    });
  }
}

// Function อัปเดตชื่อแผงและ Vendor LINE ของ BoothJob เดิมหลัง Gate แก้ไข (id/สถานะคงเดิม)
export async function updateBoothJobAfterGateEdit(
  boothJobId: number,
  data: {
    boothName: string | null;
    vendorLineId: string | null;
  },
  connection?: DbConnection
): Promise<void> {
  const db = client(connection);

  await db.boothJob.update({
    where: {
      id: boothJobId,
    },
    data,
  });
}

// Function อัปเดตสินค้าเดิมของแผงหลัง Gate แก้ไข (rate snapshot เปลี่ยนเฉพาะเมื่อส่งมา เช่นตอนย้ายตลาด)
export async function updateTicketProductAfterGateEdit(
  ticketProductId: number,
  product: GateProductCreateInput,
  options: {
    refreshRateSnapshot: boolean;
  },
  connection?: DbConnection
): Promise<void> {
  const db = client(connection);
  const data = buildTicketProductData(product);

  await db.ticketProduct.update({
    where: {
      id: ticketProductId,
    },
    data: options.refreshRateSnapshot
      ? data
      : {
        productFullCode: data.productFullCode,
        productName: data.productName,
        packageName: data.packageName,
        quantity: data.quantity,
        requiredWorkerCountSnapshot: data.requiredWorkerCountSnapshot,
      },
  });
}

// Function ลบสินค้าที่ Gate นำออกจากแผงที่ยังไม่ส่งยอด (ยังไม่มีข้อมูลการเงินผูกอยู่)
export async function deleteTicketProducts(
  ticketProductIds: number[],
  connection?: DbConnection
): Promise<void> {
  if (ticketProductIds.length === 0) {
    return;
  }

  const db = client(connection);

  await db.ticketProduct.deleteMany({
    where: {
      id: {
        in: ticketProductIds,
      },
    },
  });
}

// Function รวม workersRequired ของทุก MarketJob ที่ยัง active ในงานรถ (ไม่มีแถวคืน null)
export async function sumActiveMarketJobWorkersRequired(
  ticketJobId: number,
  connection?: DbConnection
): Promise<number | null> {
  const db = client(connection);
  const result = await db.marketJob.aggregate({
    where: {
      ticketJobId,
      status: { not: VEHICLE_JOB_STATUS.CANCELLED },
    },
    _sum: {
      workersRequired: true,
    },
  });

  return result._sum.workersRequired;
}

// Function นับจำนวน MarketJob ที่ยัง active ใต้ TicketJob เดียวกัน
export async function countActiveMarketJobs(
  ticketJobId: number,
  connection?: DbConnection
): Promise<number> {
  const db = client(connection);

  return db.marketJob.count({
    where: {
      ticketJobId,
      status: { not: VEHICLE_JOB_STATUS.CANCELLED },
    },
  });
}

// Function อัปเดต workersRequired, จำนวน Ticket และเวลาปิดรับของงานรถหลังรับ Business Ticket
export async function finalizeTicketJob(
  ticketJobId: number,
  data: {
    workersRequired: number;
    expectedTicketCount: number;
    ticketsClosedAt: Date;
  },
  connection?: DbConnection
): Promise<TicketJobDto> {
  const db = client(connection);
  const ticketJob = await db.ticketJob.update({
    where: {
      id: ticketJobId,
    },
    data,
  });

  return requireDto(mapTicketJob(ticketJob), "vehicle job finalize");
}

// Function บันทึก Gate request log สำหรับ replay/idempotency และ audit การแก้ไขตั๋ว
export async function createGateRequestLog(
  data: {
    gateTransactionRef: string;
    requestType: "CREATE" | "UPDATE";
    // เฉพาะ UPDATE
    result?: "UPDATED" | "NO_CHANGE";
    gateNo: string;
    gateClientId: number | null;
    ticketJobId: number;
    // null เมื่อ request เดียวสร้างหลายตั๋ว
    marketJobId: number | null;
    payloadSnapshot: Prisma.InputJsonValue;
    responseSnapshot?: Prisma.InputJsonValue;
    changeSummary?: Prisma.InputJsonValue;
    changeDetails?: Prisma.InputJsonValue;
    beforeSnapshot?: Prisma.InputJsonValue;
    afterSnapshot?: Prisma.InputJsonValue;
  },
  connection?: DbConnection
): Promise<void> {
  const db = client(connection);

  await db.gateRequestLog.create({
    data,
  });
}

// Function อัปเดต gate request response จาก DB
export async function updateGateRequestResponse(
  gateTransactionRef: string,
  responseSnapshot: Prisma.InputJsonValue,
  connection?: DbConnection
): Promise<void> {
  const db = client(connection);
  await db.gateRequestLog.update({
    where: {
      gateTransactionRef,
    },
    data: {
      responseSnapshot,
    },
  });
}
