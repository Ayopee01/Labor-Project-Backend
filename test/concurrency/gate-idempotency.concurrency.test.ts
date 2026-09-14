import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { after, before, test } from "node:test";

import ApiError from "../../src/utils/api-error";
import {
  applyIsolatedTestEnv,
  assertSafeTestDatabaseUrl,
  assertSafeTestRedisUrl,
} from "../setup/test-env";

/* -------------------------------------- Config -------------------------------------- */

const runDbTests = process.env.RUN_DB_TESTS === "1";

// ต่อ Postgres จริง เพื่อพิสูจน์ว่า gate_transaction_ref idempotency ใน gate.service.ts กันสอง
// request เหมือนกันเป๊ะที่ยิงพร้อมกันจริงสร้าง TicketJob ซ้ำกันไม่ได้ ดู test/concurrency/README.md
let prismaModule: typeof import("../../src/db/prisma");
let gateService: typeof import("../../src/services/gate.service");

/* -------------------------------------- Helpers -------------------------------------- */

// Function สร้างเลข 14 หลักล้วน (ตามที่ boothJobIdSchema บังคับ) ไม่ซ้ำกันในแต่ละ run
function buildFourteenDigitId(): string {
  const combined = `${Date.now()}${randomInt(0, 10)}`;

  return combined.slice(-14).padStart(14, "0");
}

/* -------------------------------------- Setup -------------------------------------- */

before(async () => {
  if (!runDbTests) {
    return;
  }

  applyIsolatedTestEnv("concurrency");
  assertSafeTestDatabaseUrl();
  assertSafeTestRedisUrl();

  prismaModule = await import("../../src/db/prisma");
  gateService = await import("../../src/services/gate.service");
});

after(async () => {
  if (!runDbTests) {
    return;
  }

  if (prismaModule) {
    await prismaModule.closePrisma();
  }
});

/* -------------------------------------- Tests -------------------------------------- */

test(
  "concurrent identical POST /api/gate/tickets requests never create the same TicketJob twice (gate_transaction_ref idempotency)",
  {
    skip: runDbTests
      ? false
      : "Set RUN_DB_TESTS=1 and run PostgreSQL migration before this test.",
  },
  async () => {
    const suffix = Date.now().toString(36);
    const marketCode = `CC-GATE-MKT-${suffix}`;
    const boothCode = `CC-GATE-BOOTH-${suffix}`;
    const productCode = `CC-GATE-PRD-${suffix}`;
    const packageCode = `CC-GATE-PKG-${suffix}`;
    const ticketNumber = buildFourteenDigitId();
    const ticketNo = buildFourteenDigitId();

    const masterProductId = 900_000_000 + randomInt(0, 1_000_000);
    const masterMarketBoothId = 900_000_000 + randomInt(0, 1_000_000);
    const masterRateSourceId = 900_000_000 + randomInt(0, 1_000_000);

    try {
      // --- Master data ที่ต้องมีจริงให้ rate resolution ผ่านได้ (MarketCode+BoothCode active, Product
      // package weight ต้องอยู่ในช่วง weightMin/weightMax ของ Rate, workerRanges ต้องมีค่า > 0) ---
      await prismaModule.prisma.masterMarket.create({
        data: {
          sourceBoothId: masterMarketBoothId,
          marketCode,
          marketName: "Concurrency Test Market",
          boothCode,
          boothName: "Concurrency Test Booth",
          boothStatus: "Normal",
          marketStatus: "Normal",
        },
      });

      await prismaModule.prisma.masterProduct.create({
        data: {
          id: masterProductId,
          productCode,
          productFullCode: productCode,
          productName: "Concurrency Test Product",
          packageCode,
          packageName: "Concurrency Test Package",
          packageWeight: 20,
          range: {
            workerRanges: {
              range1To50: 2,
              range51To100: 2,
              range101To200: 2,
              range201To400: 2,
              range401To600: 2,
              rangeOver600: 2,
            },
          },
          status: "ACTIVE",
          updateDate: new Date(),
        },
      });

      await prismaModule.prisma.masterRate.create({
        data: {
          sourceRateId: masterRateSourceId,
          marketCode,
          weightRangeName: "10-30",
          weightMin: 10,
          weightMax: 30,
          stallRate: 5,
          laborRate: 3,
          status: 1,
        },
      });

      // ต้องมี Vendor LINE mapping (owner stall) ให้ครบ ไม่งั้น createTicketJobFromGate จะ throw
      // BOOTH_VENDOR_LINE_NOT_CONFIGURED ก่อนถึงขั้นตอน idempotency check เลยด้วยซ้ำ
      await prismaModule.prisma.masterOwnerStall.create({
        data: {
          marketCode,
          boothCode,
          cardId: `CC-GATE-CARD-${suffix}`,
          ownerStatus: "Normal",
          lineUserId: `Uconcurrency${suffix}`,
          status: "active",
        },
      });

      const body = {
        TicketNumber: ticketNumber,
        TicketNo: ticketNo,
        TicketCreatedAt: new Date().toISOString(),
        BoothCount: 1,
        MarketCode: marketCode,
        DropoffPoint: "Zone CC",
        LicensePlate: "1กก-9999",
        LicensePlateProvince: "Bangkok",
        VehicleTypeCode: "TRUCK",
        VehicleTypeName: "Truck",
        Booths: [
          {
            BoothCode: boothCode,
            Products: [
              {
                ProductCode: productCode,
                PackageCode: packageCode,
                Quantity: 10,
              },
            ],
          },
        ],
        Dispatch: false,
      };

      // ยิง request เดิมเป๊ะพร้อมกันจริง 2 ครั้ง (gate_transaction_ref เดียวกัน เพราะ hash จาก body
      // เดียวกัน) — ถ้า idempotency lock ไม่ทำงานจริง ทั้งสองฝั่งจะพยายามสร้าง TicketJob ซ้ำกัน
      const results = await Promise.allSettled([
        gateService.createTicketJobFromGate(body),
        gateService.createTicketJobFromGate(body),
      ]);

      const ticketJobs = await prismaModule.prisma.ticketJob.findMany({
        where: { ticketNumber },
      });

      assert.equal(
        ticketJobs.length,
        1,
        `Expected exactly 1 TicketJob row for TicketNumber ${ticketNumber}, found ${ticketJobs.length} — the gate_transaction_ref idempotency check failed to prevent a duplicate create under real concurrency.`
      );

      const created = results.filter(
        (result) => result.status === "fulfilled" && result.value.Result === "CREATED"
      );
      const replayed = results.filter(
        (result) => result.status === "fulfilled" && result.value.Result === "REPLAYED"
      );
      const rejectedWithCleanError = results.filter(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof ApiError &&
          result.reason.code === "GATE_REQUEST_RESPONSE_NOT_READY"
      );

      assert.equal(created.length, 1, "Exactly one of the two concurrent requests must win and create the ticket.");
      assert.equal(
        replayed.length + rejectedWithCleanError.length,
        1,
        "The losing request must either see a clean REPLAYED response or a clean GATE_REQUEST_RESPONSE_NOT_READY 409 — never crash or silently duplicate."
      );

      // ถ้ามี request ไหน reject ด้วย error อื่นที่ไม่ใช่ ApiError ที่คาดไว้ (เช่น Prisma unique
      // constraint ดิบๆ) ให้ throw ออกไปตรงๆ เพื่อให้เห็น stack trace ชัดว่า idempotency พังแบบไหน
      for (const result of results) {
        if (result.status === "rejected" && !(result.reason instanceof ApiError)) {
          throw result.reason;
        }
      }
    } finally {
      const boothJobs = await prismaModule.prisma.boothJob.findMany({
        where: { ticketJob: { ticketNumber } },
        select: { id: true },
      });
      const boothJobIds = boothJobs.map((ticket) => ticket.id);

      if (boothJobIds.length > 0) {
        await prismaModule.prisma.ticketProduct.deleteMany({
          where: { ticketId: { in: boothJobIds } },
        });
      }

      await prismaModule.prisma.boothJob.deleteMany({
        where: { ticketJob: { ticketNumber } },
      });
      await prismaModule.prisma.gateRequestLog.deleteMany({
        where: { ticketJob: { ticketNumber } },
      });
      await prismaModule.prisma.marketJob.deleteMany({
        where: { ticketJob: { ticketNumber } },
      });
      await prismaModule.prisma.ticketJob.deleteMany({
        where: { ticketNumber },
      });

      await prismaModule.prisma.masterRate.deleteMany({
        where: { sourceRateId: masterRateSourceId },
      });
      await prismaModule.prisma.masterProduct.deleteMany({
        where: { id: masterProductId },
      });
      await prismaModule.prisma.masterMarket.deleteMany({
        where: { sourceBoothId: masterMarketBoothId },
      });
      await prismaModule.prisma.masterOwnerStall.deleteMany({
        where: { marketCode, boothCode },
      });
    }
  }
);
