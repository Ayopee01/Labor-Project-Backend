// Import Library
import { Prisma, type MasterProduct, type MasterRate } from "@prisma/client";

// Import Repositories
import * as masterDataRepository from "../../repositories/shared/master-data.repository";
// Import Types
import type { DbConnection } from "../../types/shared/common.type";
// Import Utils
import ApiError from "../../utils/api-error";
import { decimalToWeightString, packageWeightToDecimal } from "../../utils/labor-job-pricing";

/* -------------------------------------- Types -------------------------------------- */

export type ResolvedPackageWeight = {
  packageWeight: Prisma.Decimal;
  packageName: string;
  // SPECIFIC_PRODUCT_PACKAGE = เจอตรง ProductCode + PackageCode
  // PACKAGE_FALLBACK = ไม่เจอเจาะจง แต่เจอ PackageWeight จาก PackageCode เดียวกันของสินค้าอื่น
  // (PackageWeight เป็นคุณสมบัติของแพ็กเกจ ไม่ผูกกับสินค้า)
  resolvedVia: "SPECIFIC_PRODUCT_PACKAGE" | "PACKAGE_FALLBACK";
};

/* -------------------------------------- Functions -------------------------------------- */

// Function เลือกแถวที่ใช้ได้จาก candidate หลายแถวแบบ deterministic — ถ้าทุกแถว PackageWeight เท่ากัน
// ถือว่าไม่ ambiguous จริง ใช้แถวแรกตาม id asc ได้เลย แต่ถ้า PackageWeight ต่างกันคือ ambiguous จริง ต้อง throw
function resolveDeterministicCandidate<
  T extends { packageWeight: number }
>(candidates: T[], ambiguousErrorCode: string, context: Record<string, unknown>): T {
  const distinctWeights = new Set(candidates.map((candidate) => candidate.packageWeight));

  if (distinctWeights.size > 1) {
    throw new ApiError(
      409,
      ambiguousErrorCode,
      "Matched more than one active product with conflicting package weights.",
      {
        ...context,
        matched_count: candidates.length,
        conflicting_weights: [...distinctWeights],
      }
    );
  }

  // ทุกแถว PackageWeight เท่ากัน ใช้แถวแรกตามลำดับ id asc ที่ repository query มา (deterministic)
  return candidates[0];
}

// Function หา Product + Package แบบเจาะจง (ProductCode + PackageCode ต้องตรงเป๊ะ) ใช้ตอน Gate สร้าง
// Ticket เพราะต้องใช้ Worker Requirement (range) ของ Product นี้โดยเฉพาะ — ห้าม fallback ด้วย PackageCode
// อย่างเดียว ถ้าต้องการแค่ PackageWeight ให้ใช้ resolvePackageWeight แทน
export async function requireActiveMasterProduct(
  productCode: string,
  packageCode: string,
  connection?: DbConnection
): Promise<MasterProduct> {
  const products =
    await masterDataRepository.listActiveProductsByProductCodeAndPackageCode(
      productCode,
      packageCode,
      connection
    );

  if (products.length === 0) {
    throw new ApiError(
      409,
      "PRODUCT_PACKAGE_NOT_FOUND",
      "Active product package was not found.",
      {
        productCode,
        packageCode,
      }
    );
  }

  if (products.length === 1) {
    return products[0];
  }

  return resolveDeterministicCandidate(products, "AMBIGUOUS_PRODUCT_PACKAGE", {
    productCode,
    packageCode,
  });
}

// Function หา PackageWeight จาก ProductCode+PackageCode สำหรับ Rate Resolution เท่านั้น — เจอ Specific
// ใช้ตัวนั้น ไม่เจอ fallback ด้วย PackageCode อย่างเดียว (PackageWeight เป็นคุณสมบัติของแพ็กเกจ ไม่ผูกสินค้า)
// ใช้เฉพาะตอน Worker เปลี่ยน PackageCode ระหว่างส่งยอด ห้ามใช้กับ Flow ที่ต้องใช้ Worker Requirement (เช่น Gate สร้าง Ticket)
export async function resolvePackageWeight(
  productCode: string,
  packageCode: string,
  connection?: DbConnection
): Promise<ResolvedPackageWeight> {
  const specificProducts =
    await masterDataRepository.listActiveProductsByProductCodeAndPackageCode(
      productCode,
      packageCode,
      connection
    );

  if (specificProducts.length > 0) {
    const resolved =
      specificProducts.length === 1
        ? specificProducts[0]
        : resolveDeterministicCandidate(
            specificProducts,
            "AMBIGUOUS_PRODUCT_PACKAGE",
            { productCode, packageCode }
          );

    return {
      packageWeight: packageWeightToDecimal(resolved.packageWeight),
      packageName: resolved.packageName,
      resolvedVia: "SPECIFIC_PRODUCT_PACKAGE",
    };
  }

  const fallbackProducts = await masterDataRepository.listActiveProductsByPackageCode(
    packageCode,
    connection
  );

  if (fallbackProducts.length === 0) {
    throw new ApiError(
      409,
      "PRODUCT_PACKAGE_NOT_FOUND",
      "Active product package was not found.",
      {
        productCode,
        packageCode,
      }
    );
  }

  const resolvedFallback =
    fallbackProducts.length === 1
      ? fallbackProducts[0]
      : resolveDeterministicCandidate(
          fallbackProducts,
          "AMBIGUOUS_PACKAGE_WEIGHT",
          { productCode, packageCode }
        );

  return {
    packageWeight: packageWeightToDecimal(resolvedFallback.packageWeight),
    packageName: resolvedFallback.packageName,
    resolvedVia: "PACKAGE_FALLBACK",
  };
}

// Function หา rate ตามตลาดและน้ำหนักสินค้า
export async function requireApplicableRate(
  marketCode: string,
  packageWeight: Prisma.Decimal,
  connection?: DbConnection
): Promise<{
  rate: MasterRate;
  requestedMarketCode: string;
  appliedMarketCode: string;
  rateSource: "MARKET_RATE" | "CENTRAL_RATE";
}> {
  const marketRates =
    await masterDataRepository.listActiveRatesByMarketAndWeight(
      marketCode,
      packageWeight,
      connection
    );

  if (marketRates.length > 1) {
    throw new ApiError(
      409,
      "DUPLICATE_RATE_CONFIGURATION",
      "More than one active rate matched this market and package weight.",
      {
        marketCode,
        packageWeight: decimalToWeightString(packageWeight),
      }
    );
  }

  if (marketRates.length === 1) {
    return {
      rate: marketRates[0],
      requestedMarketCode: marketCode,
      appliedMarketCode: marketRates[0].marketCode,
      rateSource: "MARKET_RATE",
    };
  }

  const centralRates =
    await masterDataRepository.listActiveRatesByMarketAndWeight(
      "0000",
      packageWeight,
      connection
    );

  if (centralRates.length > 1) {
    throw new ApiError(
      409,
      "DUPLICATE_RATE_CONFIGURATION",
      "More than one active central rate matched this package weight.",
      {
        marketCode: "0000",
        packageWeight: decimalToWeightString(packageWeight),
      }
    );
  }

  if (centralRates.length === 0) {
    throw new ApiError(
      409,
      "RATE_NOT_FOUND",
      "No active rate matched this market or central rate.",
      {
        requestedMarketCode: marketCode,
        fallbackMarketCode: "0000",
        packageWeight: decimalToWeightString(packageWeight),
      }
    );
  }

  return {
    rate: centralRates[0],
    requestedMarketCode: marketCode,
    appliedMarketCode: centralRates[0].marketCode,
    rateSource: "CENTRAL_RATE",
  };
}
