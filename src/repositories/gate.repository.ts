// Import Library
import { Prisma, type MasterMarket } from "@prisma/client";
// Import Config
import { MASTER_MARKET_ACTIVE_STATUS, MASTER_OWNER_STALL_ACTIVE_STATUS, VEHICLE_JOB_STATUS } from "../constants/status";
// Import Repositories
import * as boothJobRepository from "./shared/booth-job.repository";
import { client, createRandomToken, requireDto } from "./shared/repository-utils";
// Import Mappers
import { mapMarketJob, mapTicketJob } from "./shared/mappers";
// Import Types
import type { DbConnection } from "../types/shared/common.type";
import type { GateRequestReplayRecord, BoothJobJobCreateInput, BoothJobJobResponse, GateBoothOption } from "../types/gate.type";
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

// Function ดึง BoothCode ที่มีอยู่แล้วใน Business Ticket (ใช้กัน BoothCode ซ้ำตอนเพิ่มแผง)
export async function listBoothJobBoothCodesByMarketJobId(
  marketJobId: number,
  connection?: DbConnection
): Promise<string[]> {
  const db = client(connection);
  const tickets = await db.boothJob.findMany({
    where: {
      marketJobId,
    },
    select: {
      boothCode: true,
    },
  });

  return tickets.map((ticket) => ticket.boothCode);
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

// Function เพิ่มแผงเข้า Business Ticket ที่ active อยู่ (boothCount บวกเฉพาะแผงใหม่)
export async function appendMarketJobBooths(
  marketJobId: number,
  data: {
    boothCountIncrement: number;
    workersRequired: number;
    gateTransactionRef: string;
  },
  connection?: DbConnection
): Promise<MarketJobDto> {
  const db = client(connection);
  const marketJob = await db.marketJob.update({
    where: {
      id: marketJobId,
    },
    data: {
      boothCount: { increment: data.boothCountIncrement },
      workersRequired: data.workersRequired,
      gateTransactionRef: data.gateTransactionRef,
    },
  });

  return requireDto(mapMarketJob(marketJob), "market job append");
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

// Function สร้าง BoothJob ของแต่ละแผงพร้อม TicketProduct
export async function createBoothJobsWithProducts(
  ticketJobId: number,
  marketJobId: number,
  booths: BoothJobJobCreateInput["markets"][number]["booths"],
  ticketStatus: string,
  connection?: DbConnection
): Promise<void> {
  const db = client(connection);

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

    for (const product of booth.products) {
      await db.ticketProduct.create({
        data: {
          ticketId,
          productCode: product.productCode,
          productFullCode: product.productFullCode,
          productName: product.productName,
          packageCode: product.packageCode,
          packageName: product.packageName,
          quantity: product.quantity,
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
        },
      });
    }
  }
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

// Function บันทึก Gate request log สำหรับ replay/idempotency
export async function createGateRequestLog(
  data: {
    gateTransactionRef: string;
    ticketJobId: number;
    marketJobId: number;
    payloadSnapshot: Prisma.InputJsonValue;
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
