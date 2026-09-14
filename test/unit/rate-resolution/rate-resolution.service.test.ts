import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import Module = require("node:module");
import { Prisma, type MasterProduct, type MasterRate } from "@prisma/client";

import ApiError from "../../../src/utils/api-error";
import * as laborJobPricing from "../../../src/utils/labor-job-pricing";
// Import real repository for boundary where-clause tests
import * as masterDataRepositoryReal from "../../../src/repositories/shared/master-data.repository";
import type { DbConnection } from "../../../src/types/shared/common.type";

/* -------------------------------------- Test Env -------------------------------------- */

// ต้องยาวอย่างน้อย 32 ตัวอักษรเพื่อผ่านเกณฑ์ความแข็งแรงของ Secret ที่ jwt.ts/refresh-token-hash.ts เช็ค
process.env.JWT_ACCESS_SECRET = "test-access-secret-min-32-charss";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-min-32-chars";
process.env.JWT_LOGIN_CHALLENGE_SECRET = "test-login-challenge-secret-min-32";
process.env.REFRESH_TOKEN_HASH_SECRET = "test-refresh-hash-secret-min-32-ok";

/* -------------------------------------- Module Loader Patch -------------------------------------- */
// Mock master-data repository through Module._load before loading the service

type ModuleLoad = (
  request: string,
  parent: NodeModule | null | undefined,
  isMain: boolean
) => unknown;

type ModuleWithLoad = typeof Module & { _load: ModuleLoad };

const moduleWithLoad = Module as ModuleWithLoad;
const originalLoad = moduleWithLoad._load;

const masterDataRepositoryStub = {
  listActiveProductsByProductCodeAndPackageCode: async (
    _productCode: string,
    _packageCode: string
  ): Promise<MasterProduct[]> => [],

  listActiveProductsByPackageCode: async (
    _packageCode: string
  ): Promise<MasterProduct[]> => [],

  listActiveRatesByMarketAndWeight: async (
    _marketCode: string,
    _packageWeight: Prisma.Decimal
  ): Promise<MasterRate[]> => [],
};

moduleWithLoad._load = function patchedLoad(
  request: string,
  parent: NodeModule | null | undefined,
  isMain: boolean
) {
  if (request === "../../repositories/shared/master-data.repository") {
    return masterDataRepositoryStub;
  }

  return originalLoad.call(moduleWithLoad, request, parent, isMain);
};

after(() => {
  moduleWithLoad._load = originalLoad;
});

// Function loads service after Module._load is patched
const rateResolutionService =
  require("../../../src/services/shared/rate-resolution.service") as typeof import("../../../src/services/shared/rate-resolution.service");

/* -------------------------------------- Fixture Builders -------------------------------------- */

let nextMasterProductId = 1;

function buildMasterProduct(
  overrides: Partial<MasterProduct> & {
    productCode: string;
    packageCode: string;
    packageWeight: number;
  }
): MasterProduct {
  const id = overrides.id ?? nextMasterProductId++;

  return {
    id,
    productCode: overrides.productCode,
    productFullCode: overrides.productFullCode ?? `${overrides.productCode}-FULL-${id}`,
    productName: overrides.productName ?? `Product ${overrides.productCode}`,
    packageCode: overrides.packageCode,
    packageName: overrides.packageName ?? `Package ${overrides.packageCode}`,
    packageWeight: overrides.packageWeight,
    range: overrides.range ?? {},
    status: overrides.status ?? "ACTIVE",
    updateDate: overrides.updateDate ?? new Date("2026-01-01T00:00:00.000Z"),
    createDate: overrides.createDate ?? new Date("2026-01-01T00:00:00.000Z"),
  };
}

let nextMasterRateId = 1;

function buildMasterRate(
  overrides: Omit<
    Partial<MasterRate>,
    "weightMin" | "weightMax" | "stallRate" | "laborRate"
  > & {
    marketCode: string;
    weightMin: string;
    weightMax: string;
    stallRate: string;
    laborRate: string;
  }
): MasterRate {
  const id = overrides.id ?? nextMasterRateId++;

  return {
    id,
    sourceRateId: overrides.sourceRateId ?? id,
    marketCode: overrides.marketCode,
    weightRangeName: overrides.weightRangeName ?? `${overrides.weightMin}-${overrides.weightMax}`,
    weightMin: new Prisma.Decimal(overrides.weightMin),
    weightMax: new Prisma.Decimal(overrides.weightMax),
    stallRate: new Prisma.Decimal(overrides.stallRate),
    laborRate: new Prisma.Decimal(overrides.laborRate),
    status: overrides.status ?? 1,
    sourceCreatedAt: overrides.sourceCreatedAt ?? null,
    sourceUpdatedAt: overrides.sourceUpdatedAt ?? null,
    syncedAt: overrides.syncedAt ?? new Date("2026-01-01T00:00:00.000Z"),
    createdAt: overrides.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-01-01T00:00:00.000Z"),
  };
}

// Function reset stub กลับสู่ default ("ไม่พบอะไรเลย") ก่อนทุก test กันไม่ให้ test ก่อนหน้าตกค้าง
function resetMasterDataStub(): void {
  masterDataRepositoryStub.listActiveProductsByProductCodeAndPackageCode = async () => [];
  masterDataRepositoryStub.listActiveProductsByPackageCode = async () => [];
  masterDataRepositoryStub.listActiveRatesByMarketAndWeight = async () => [];
}

before(resetMasterDataStub);

// Function assert ว่า promise reject ด้วย ApiError code ที่ต้องการ
async function assertApiErrorCode(
  action: () => Promise<unknown>,
  expectedCode: string
): Promise<void> {
  await assert.rejects(
    action,
    (error: unknown) => error instanceof ApiError && error.code === expectedCode
  );
}

// Function simulates Prisma Decimal comparison operators
function matchesDecimalFilter(value: Prisma.Decimal, filter: unknown): boolean {
  if (filter === undefined || filter === null) {
    return true;
  }

  const operators = filter as {
    lt?: Prisma.Decimal;
    lte?: Prisma.Decimal;
    gt?: Prisma.Decimal;
    gte?: Prisma.Decimal;
  };

  if (operators.lt !== undefined && !value.lt(operators.lt)) {
    return false;
  }

  if (operators.lte !== undefined && !value.lte(operators.lte)) {
    return false;
  }

  if (operators.gt !== undefined && !value.gt(operators.gt)) {
    return false;
  }

  if (operators.gte !== undefined && !value.gte(operators.gte)) {
    return false;
  }

  return true;
}

// Function builds fake DbConnection for where-clause tests
function buildFakeMasterRateConnection(rates: MasterRate[]): DbConnection {
  return {
    masterRate: {
      findMany: async ({
        where,
        orderBy,
      }: {
        where: Record<string, unknown>;
        orderBy?: { id?: "asc" | "desc" };
      }) => {
        const filtered = rates.filter((rate) => {
          if (where.marketCode !== undefined && rate.marketCode !== where.marketCode) {
            return false;
          }

          if (where.status !== undefined && rate.status !== where.status) {
            return false;
          }

          if (!matchesDecimalFilter(rate.weightMin, where.weightMin)) {
            return false;
          }

          if (!matchesDecimalFilter(rate.weightMax, where.weightMax)) {
            return false;
          }

          return true;
        });

        return filtered.sort((left, right) =>
          orderBy?.id === "desc" ? right.id - left.id : left.id - right.id
        );
      },
    },
  } as unknown as DbConnection;
}

/* -------------------------------------- Test 1: Specific Product Package พบ -------------------------------------- */

test("resolvePackageWeight uses the specific ProductCode + PackageCode weight when it exists", async () => {
  resetMasterDataStub();

  const specific = buildMasterProduct({
    productCode: "02020300",
    packageCode: "29",
    packageWeight: 20,
    packageName: "ลัง 20",
  });

  masterDataRepositoryStub.listActiveProductsByProductCodeAndPackageCode = async () => [
    specific,
  ];
  masterDataRepositoryStub.listActiveProductsByPackageCode = async () => {
    throw new Error("must not fall back when specific match exists");
  };

  const resolved = await rateResolutionService.resolvePackageWeight("02020300", "29");

  assert.equal(resolved.packageWeight.toString(), "20");
  assert.equal(resolved.packageName, "ลัง 20");
  assert.equal(resolved.resolvedVia, "SPECIFIC_PRODUCT_PACKAGE");
});

/* -------------------------------------- Test 2: Specific ไม่พบ แต่ Package fallback พบ -------------------------------------- */

test("resolvePackageWeight falls back to PackageCode-only weight when the specific pair is not found, then resolves rate via central fallback", async () => {
  resetMasterDataStub();

  const fallbackCandidate = buildMasterProduct({
    productCode: "05030102",
    packageCode: "22",
    packageWeight: 25,
    packageName: "กล่อง 25",
  });

  masterDataRepositoryStub.listActiveProductsByProductCodeAndPackageCode = async () => [];
  masterDataRepositoryStub.listActiveProductsByPackageCode = async () => [fallbackCandidate];

  const resolved = await rateResolutionService.resolvePackageWeight("999999999", "22");

  assert.equal(resolved.packageWeight.toString(), "25");
  assert.equal(resolved.resolvedVia, "PACKAGE_FALLBACK");

  const centralRate = buildMasterRate({
    marketCode: "0000",
    weightRangeName: "1-25.0",
    weightMin: "0.00",
    weightMax: "25.00",
    stallRate: "1.50",
    laborRate: "0.90",
  });

  masterDataRepositoryStub.listActiveRatesByMarketAndWeight = async (marketCode: string) =>
    marketCode === "0000" ? [centralRate] : [];

  const applicableRate = await rateResolutionService.requireApplicableRate(
    "9999",
    resolved.packageWeight
  );

  assert.equal(applicableRate.rateSource, "CENTRAL_RATE");
  assert.equal(applicableRate.appliedMarketCode, "0000");
  assert.equal(applicableRate.rate.stallRate.toString(), "1.5");
  assert.equal(applicableRate.rate.laborRate.toString(), "0.9");
});

/* -------------------------------------- Test 3: ProductCode+PackageCode ซ้ำ แต่ Weight เหมือนกัน -------------------------------------- */

test("requireActiveMasterProduct resolves duplicate ProductCode + PackageCode rows when every PackageWeight matches", async () => {
  resetMasterDataStub();

  const recordA = buildMasterProduct({
    productCode: "02011002",
    packageCode: "29",
    packageWeight: 20,
    productFullCode: "02011002000000000000",
  });
  const recordB = buildMasterProduct({
    productCode: "02011002",
    packageCode: "29",
    packageWeight: 20,
    productFullCode: "02011002400000000000",
  });

  masterDataRepositoryStub.listActiveProductsByProductCodeAndPackageCode = async () => [
    recordA,
    recordB,
  ];

  const resolved = await rateResolutionService.requireActiveMasterProduct("02011002", "29");

  assert.equal(resolved.packageWeight, 20);
  // ต้องได้แถวแรกตาม id asc เสมอ (deterministic) ไม่ใช่แถวสุ่ม
  assert.equal(resolved.id, recordA.id);
});

test("resolvePackageWeight also resolves duplicate specific rows when every PackageWeight matches", async () => {
  resetMasterDataStub();

  const recordA = buildMasterProduct({
    productCode: "02011002",
    packageCode: "29",
    packageWeight: 20,
  });
  const recordB = buildMasterProduct({
    productCode: "02011002",
    packageCode: "29",
    packageWeight: 20,
  });

  masterDataRepositoryStub.listActiveProductsByProductCodeAndPackageCode = async () => [
    recordA,
    recordB,
  ];

  const resolved = await rateResolutionService.resolvePackageWeight("02011002", "29");

  assert.equal(resolved.packageWeight.toString(), "20");
  assert.equal(resolved.resolvedVia, "SPECIFIC_PRODUCT_PACKAGE");
});

/* -------------------------------------- Test 4: ProductCode+PackageCode ซ้ำ และ Weight ต่างกัน -------------------------------------- */

test("requireActiveMasterProduct throws AMBIGUOUS_PRODUCT_PACKAGE when duplicate rows disagree on PackageWeight and never guesses the first row", async () => {
  resetMasterDataStub();

  const recordA = buildMasterProduct({
    productCode: "02011002",
    packageCode: "13",
    packageWeight: 15,
  });
  const recordB = buildMasterProduct({
    productCode: "02011002",
    packageCode: "13",
    packageWeight: 20,
  });

  masterDataRepositoryStub.listActiveProductsByProductCodeAndPackageCode = async () => [
    recordA,
    recordB,
  ];

  await assertApiErrorCode(
    () => rateResolutionService.requireActiveMasterProduct("02011002", "13"),
    "AMBIGUOUS_PRODUCT_PACKAGE"
  );
});

/* -------------------------------------- Test 5: Package fallback ambiguous -------------------------------------- */

test("resolvePackageWeight throws AMBIGUOUS_PACKAGE_WEIGHT when the PackageCode fallback itself disagrees on weight, and never guesses", async () => {
  resetMasterDataStub();

  const recordA = buildMasterProduct({
    productCode: "AAA",
    packageCode: "21",
    packageWeight: 15,
  });
  const recordB = buildMasterProduct({
    productCode: "BBB",
    packageCode: "21",
    packageWeight: 20,
  });

  masterDataRepositoryStub.listActiveProductsByProductCodeAndPackageCode = async () => [];
  masterDataRepositoryStub.listActiveProductsByPackageCode = async () => [recordA, recordB];

  await assertApiErrorCode(
    () => rateResolutionService.resolvePackageWeight("CCC", "21"),
    "AMBIGUOUS_PACKAGE_WEIGHT"
  );
});

/* -------------------------------------- Not found ทั้ง Specific และ Fallback -------------------------------------- */

test("resolvePackageWeight throws PRODUCT_PACKAGE_NOT_FOUND when neither the specific pair nor the PackageCode fallback exists", async () => {
  resetMasterDataStub();

  await assertApiErrorCode(
    () => rateResolutionService.resolvePackageWeight("999999999", "does-not-exist"),
    "PRODUCT_PACKAGE_NOT_FOUND"
  );
});

test("requireActiveMasterProduct still throws PRODUCT_PACKAGE_NOT_FOUND without falling back — Worker Requirement Logic needs the exact ProductCode + PackageCode row", async () => {
  resetMasterDataStub();

  masterDataRepositoryStub.listActiveProductsByPackageCode = async () => {
    throw new Error("requireActiveMasterProduct must never consult the package fallback table");
  };

  await assertApiErrorCode(
    () => rateResolutionService.requireActiveMasterProduct("999999999", "22"),
    "PRODUCT_PACKAGE_NOT_FOUND"
  );
});

/* -------------------------------------- Test 6: Market Rate พบโดยตรง -------------------------------------- */

test("requireApplicableRate uses the market-specific rate directly without falling back to 0000", async () => {
  resetMasterDataStub();

  const marketRate = buildMasterRate({
    marketCode: "1111",
    weightRangeName: "0.5-5.0",
    weightMin: "0.00",
    weightMax: "5.00",
    stallRate: "0.20",
    laborRate: "0.15",
  });

  masterDataRepositoryStub.listActiveRatesByMarketAndWeight = async (marketCode: string) =>
    marketCode === "1111" ? [marketRate] : [];

  const applicableRate = await rateResolutionService.requireApplicableRate(
    "1111",
    new Prisma.Decimal("3")
  );

  assert.equal(applicableRate.rateSource, "MARKET_RATE");
  assert.equal(applicableRate.appliedMarketCode, "1111");
  assert.equal(applicableRate.requestedMarketCode, "1111");
});

/* -------------------------------------- Test 7: Market ไม่มี Rate -------------------------------------- */

test("requireApplicableRate falls back to central MarketCode 0000 (never '000') when the requested market has no rate", async () => {
  resetMasterDataStub();

  const centralRate = buildMasterRate({
    marketCode: "0000",
    weightRangeName: "1-25.0",
    weightMin: "0.00",
    weightMax: "25.00",
    stallRate: "1.50",
    laborRate: "0.90",
  });

  masterDataRepositoryStub.listActiveRatesByMarketAndWeight = async (marketCode: string) =>
    marketCode === "0000" ? [centralRate] : [];

  const applicableRate = await rateResolutionService.requireApplicableRate(
    "9999",
    new Prisma.Decimal("25")
  );

  assert.equal(applicableRate.rateSource, "CENTRAL_RATE");
  assert.equal(applicableRate.appliedMarketCode, "0000");
  assert.notEqual(applicableRate.appliedMarketCode, "000");
  assert.equal(applicableRate.requestedMarketCode, "9999");
});

test("requireApplicableRate throws RATE_NOT_FOUND when even the central 0000 fallback has no matching weight range", async () => {
  resetMasterDataStub();

  await assertApiErrorCode(
    () => rateResolutionService.requireApplicableRate("9999", new Prisma.Decimal("999999")),
    "RATE_NOT_FOUND"
  );
});

/* -------------------------------------- Test 9: Golden Test สูตรเงินจริง -------------------------------------- */
// Test package/rate fallback flow through production pricing
test("golden flow: package fallback + central rate fallback feeds the existing pricing formulas correctly", async () => {
  resetMasterDataStub();

  const fallbackCandidate = buildMasterProduct({
    productCode: "05030102",
    packageCode: "22",
    packageWeight: 25,
  });

  masterDataRepositoryStub.listActiveProductsByProductCodeAndPackageCode = async () => [];
  masterDataRepositoryStub.listActiveProductsByPackageCode = async () => [fallbackCandidate];

  const centralRate = buildMasterRate({
    marketCode: "0000",
    weightRangeName: "1-25.0",
    weightMin: "0.00",
    weightMax: "25.00",
    stallRate: "1.50",
    laborRate: "0.90",
  });

  masterDataRepositoryStub.listActiveRatesByMarketAndWeight = async (marketCode: string) =>
    marketCode === "0000" ? [centralRate] : [];

  const resolvedPackage = await rateResolutionService.resolvePackageWeight("999999999", "22");

  assert.equal(resolvedPackage.packageWeight.toString(), "25");

  const applicableRate = await rateResolutionService.requireApplicableRate(
    "9999",
    resolvedPackage.packageWeight
  );

  assert.equal(applicableRate.appliedMarketCode, "0000");
  assert.equal(applicableRate.rate.stallRate.toString(), "1.5");
  assert.equal(applicableRate.rate.laborRate.toString(), "0.9");

  const stallCharge = laborJobPricing.calculateProductStallCharge({
    quantity: new Prisma.Decimal("909"),
    stallRate: applicableRate.rate.stallRate,
    laborRate: applicableRate.rate.laborRate,
  });

  assert.equal(laborJobPricing.decimalToMoneyString(stallCharge.stallFeeRaw), "1363.50");
  assert.equal(laborJobPricing.decimalToMoneyString(stallCharge.stallFeeRounded), "1364.00");
  assert.equal(laborJobPricing.decimalToMoneyString(stallCharge.laborFeeRaw), "818.10");
  assert.equal(laborJobPricing.decimalToMoneyString(stallCharge.productCharge), "2183.00");

  const workerPayment = laborJobPricing.calculateProductWorkerPayment({
    laborFeeRaw: stallCharge.laborFeeRaw,
    actualWorkerCount: 9,
  });

  assert.equal(workerPayment.rawAmountPerWorker.toFixed(8), "90.90000000");
  assert.equal(laborJobPricing.decimalToMoneyString(workerPayment.finalAmountPerWorker), "90.00");
  assert.equal(
    laborJobPricing.decimalToMoneyString(workerPayment.remainderAmountPerWorker),
    "0.90"
  );
  assert.equal(laborJobPricing.decimalToMoneyString(workerPayment.workerPayoutTotal), "810.00");
  assert.equal(laborJobPricing.decimalToMoneyString(workerPayment.fundAmount), "8.10");
});

/* -------------------------------------- Gap 1: Package fallback ที่เจอหลาย Record Weight เท่ากัน -------------------------------------- */

test("resolvePackageWeight resolves the PACKAGE_FALLBACK branch when multiple fallback rows all share the same weight", async () => {
  resetMasterDataStub();

  // จำลองตัวอย่างในโจทย์ตรงๆ: PackageCode=22 พบ 4 record คนละ ProductCode แต่ Weight=25 เท่ากันหมด
  const fallbackRows = [
    buildMasterProduct({ productCode: "AAA", packageCode: "22", packageWeight: 25 }),
    buildMasterProduct({ productCode: "BBB", packageCode: "22", packageWeight: 25 }),
    buildMasterProduct({ productCode: "CCC", packageCode: "22", packageWeight: 25 }),
    buildMasterProduct({ productCode: "DDD", packageCode: "22", packageWeight: 25 }),
  ];

  masterDataRepositoryStub.listActiveProductsByProductCodeAndPackageCode = async () => [];
  masterDataRepositoryStub.listActiveProductsByPackageCode = async () => fallbackRows;

  const resolved = await rateResolutionService.resolvePackageWeight("999999999", "22");

  assert.equal(resolved.packageWeight.toString(), "25");
  assert.equal(resolved.resolvedVia, "PACKAGE_FALLBACK");
});

/* -------------------------------------- Gap 2: Weight Range Boundary ผ่าน where-clause จริง -------------------------------------- */

test("listActiveRatesByMarketAndWeight matches the real Prisma where-clause at the exact weight boundary", async () => {
  const rangeA = buildMasterRate({
    marketCode: "0000",
    weightRangeName: "0-25",
    weightMin: "0.00",
    weightMax: "25.00",
    stallRate: "1.50",
    laborRate: "0.90",
  });
  const rangeB = buildMasterRate({
    marketCode: "0000",
    weightRangeName: "25-50",
    weightMin: "25.00",
    weightMax: "50.00",
    stallRate: "3.50",
    laborRate: "2.59",
  });

  const connection = buildFakeMasterRateConnection([rangeA, rangeB]);

  // Weight = 25.00 พอดี ต้องตกใน Range A (weightMax gte รวมขอบบน)
  const atBoundary = await masterDataRepositoryReal.listActiveRatesByMarketAndWeight(
    "0000",
    new Prisma.Decimal("25.00"),
    connection
  );

  assert.equal(atBoundary.length, 1);
  assert.equal(atBoundary[0].weightRangeName, "0-25");

  // Test Range A upper-bound exclusivity after 25.00
  const pastBoundary = await masterDataRepositoryReal.listActiveRatesByMarketAndWeight(
    "0000",
    new Prisma.Decimal("25.01"),
    connection
  );

  assert.equal(pastBoundary.length, 1);
  assert.equal(pastBoundary[0].weightRangeName, "25-50");

  // Weight = 0.00 พอดี ต้องไม่ match Range A เลย (weightMin lt คือ exclusive ที่ขอบล่าง เช่นกัน)
  const atLowerBoundary = await masterDataRepositoryReal.listActiveRatesByMarketAndWeight(
    "0000",
    new Prisma.Decimal("0.00"),
    connection
  );

  assert.equal(atLowerBoundary.length, 0);
});
